import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole } from '@/lib/auth';
import { User } from '@/models/User';
import { PushSubscription } from '@/models/PushSubscription';
import { resolveUserRole, type UserRole } from '@/lib/authz';
import { hashPassword } from '@/lib/passwords';
import { invalidateCurrentSessionCache } from '@/lib/current-session-cache';
import { listUsers, toUserDTO, USER_ADMIN_PROJECTION } from '@/lib/users';
import {
  createUserSchema,
  deleteUserSchema,
  objectIdSchema,
  updateUserSchema,
} from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import type { DeleteResponse, UserListResponse, UserMutationResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * Administración de usuarios (solo admin).
 *
 * - GET    lista sin `passwordHash`.
 * - POST   alta con bcrypt 10; `active` nace en true.
 * - PATCH  cambia rol, activa/desactiva y/o resetea contraseña (`id` en body).
 * - DELETE elimina (`id` por query `?id=` o body `{ id }`).
 *
 * Reglas duras: nadie puede darse de baja/eliminarse a sí mismo y el sistema
 * nunca puede quedar sin administradores activos. Un cambio de rol no espera
 * las 8 h de la cookie: requireCurrentSession lee el rol actual en cada
 * escritura. Desactivar o resetear la contraseña invalida las sesiones del
 * usuario incrementando `sessionVersion`.
 */

interface LeanManagedUser {
  _id: mongoose.Types.ObjectId | string;
  username?: string;
  role?: unknown;
  active?: boolean;
  sessionVersion?: number;
}

interface LeanProjectedUser {
  _id: unknown;
  username?: string;
  role?: unknown;
  active?: boolean;
  lastLoginAt?: Date | string | null;
  notificationsEnabled?: boolean;
  createdAt?: Date | string | null;
}

function effectiveRole(user: LeanManagedUser): UserRole {
  return resolveUserRole(user.role, user.username);
}

function isActive(user: LeanManagedUser): boolean {
  return user.active !== false;
}

/**
 * ¿La operación dejaría al sistema sin ningún admin activo?
 * Solo se consulta cuando el target era admin activo y deja de serlo.
 */
async function removesLastActiveAdmin(
  target: LeanManagedUser,
  nextRole: UserRole,
  nextActive: boolean,
): Promise<boolean> {
  const wasActiveAdmin = effectiveRole(target) === 'admin' && isActive(target);
  const staysActiveAdmin = nextRole === 'admin' && nextActive;

  if (!wasActiveAdmin || staysActiveAdmin) return false;

  const remainingAdmins = await User.countDocuments({
    _id: { $ne: target._id },
    role: 'admin',
    active: { $ne: false },
  });

  return remainingAdmins === 0;
}

async function findTarget(id: string): Promise<LeanManagedUser | null> {
  return User.findById(id)
    .select('username role active sessionVersion')
    .lean<LeanManagedUser | null>();
}

/** `DELETE /api/users?id=...` o body `{ id }`, indistintamente. */
async function parseDeleteUserId(
  request: Request,
): Promise<{ success: true; id: string } | { success: false; response: NextResponse }> {
  const queryId = new URL(request.url).searchParams.get('id');

  if (queryId !== null) {
    const parsed = objectIdSchema.safeParse(queryId);
    if (!parsed.success)
      return { success: false, response: errorResponse('ID de usuario inválido', 400) };
    return { success: true, id: parsed.data };
  }

  const parsedBody = await parseJsonBody(request, deleteUserSchema);
  if (!parsedBody.success) return { success: false, response: parsedBody.response };

  return { success: true, id: parsedBody.data.id };
}

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const users = await listUsers();
    const response: UserListResponse = { success: true, users };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al listar usuarios:' });
  }
});

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, createUserSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { username, password, role, active } = parsedBody.data;

    await dbConnect();

    const passwordHash = await hashPassword(password);
    const created = await User.create({
      username,
      passwordHash,
      role,
      active,
      lastLoginAt: null,
      sessionVersion: 0,
      notificationsEnabled: true,
    });

    const document =
      typeof (created as { toObject?: unknown }).toObject === 'function'
        ? (created as { toObject: () => LeanProjectedUser }).toObject()
        : (created as unknown as LeanProjectedUser);

    const response: UserMutationResponse = {
      success: true,
      message: 'Usuario creado exitosamente',
      user: toUserDTO(document),
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al crear usuario:',
      duplicateMessages: {
        username: 'Ya existe un usuario con ese nombre',
      },
    });
  }
});

export const PATCH = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, updateUserSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { id, role, active, password } = parsedBody.data;

    await dbConnect();

    const target = await findTarget(id);
    if (!target) return errorResponse('Usuario no encontrado', 404);

    const currentRole = effectiveRole(target);
    const currentActive = isActive(target);

    // Auto-baja: ni siquiera otro admin puede hacer que el propio admin se
    // desactive accidentalmente desde su sesión actual.
    if (id === auth.session.userId && active === false) {
      return errorResponse('No podés desactivar tu propio usuario', 400);
    }

    const nextRole = role ?? currentRole;
    const nextActive = active ?? currentActive;

    if (await removesLastActiveAdmin(target, nextRole, nextActive)) {
      const message =
        nextRole !== 'admin'
          ? 'No se puede quitar el rol al último administrador activo'
          : 'No se puede desactivar al último administrador activo';
      return errorResponse(message, 400);
    }

    const update: Record<string, unknown> = {};
    if (role !== undefined) update.role = role;
    if (active !== undefined) update.active = active;
    if (password !== undefined) update.passwordHash = await hashPassword(password);

    // Reset de contraseña o reactivación: las cookies viejas dejan de valer.
    if (password !== undefined || (active !== undefined && active !== currentActive)) {
      update.sessionVersion =
        (typeof target.sessionVersion === 'number' ? target.sessionVersion : 0) + 1;
    }

    const updated = await User.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true },
    )
      .select(USER_ADMIN_PROJECTION)
      .lean<LeanProjectedUser | null>();

    if (!updated) return errorResponse('Usuario no encontrado', 404);

    // El cambio de rol y la baja se aplican en la siguiente petición, sin
    // esperar el TTL del caché ni las 8 h de la cookie.
    invalidateCurrentSessionCache(id);

    const message =
      password !== undefined
        ? 'Contraseña restablecida exitosamente'
        : role !== undefined
          ? 'Rol actualizado exitosamente'
          : active
            ? 'Usuario activado exitosamente'
            : 'Usuario desactivado exitosamente';

    const response: UserMutationResponse = {
      success: true,
      message,
      user: toUserDTO(updated),
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al actualizar usuario:',
      duplicateMessages: {
        username: 'Ya existe un usuario con ese nombre',
      },
    });
  }
});

export const DELETE = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const parsedId = await parseDeleteUserId(request);
    if (!parsedId.success) return parsedId.response;

    const { id } = parsedId;

    if (id === auth.session.userId) {
      return errorResponse('No podés eliminar tu propio usuario', 400);
    }

    await dbConnect();

    const target = await findTarget(id);
    if (!target) return errorResponse('Usuario no encontrado', 404);

    if (await removesLastActiveAdmin(target, 'vendedor', false)) {
      return errorResponse('No se puede eliminar al último administrador activo', 400);
    }

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return errorResponse('Usuario no encontrado', 404);

    // Un usuario eliminado no vuelve: sus dispositivos tampoco deben seguir
    // recibiendo push (el dispatcher ya filtra inactivos, pero esto evita
    // huérfanos que nadie puede revocar desde la sesión).
    await PushSubscription.deleteMany({ userId: id }).catch((error: unknown) => {
      console.error('Error al borrar suscripciones push del usuario eliminado:', error);
    });

    invalidateCurrentSessionCache(id);

    const response: DeleteResponse = {
      success: true,
      message: 'Usuario eliminado exitosamente',
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al eliminar usuario:' });
  }
});
