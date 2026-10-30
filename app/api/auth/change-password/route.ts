import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { clearSessionCookie, requireCurrentSession } from '@/lib/auth';
import { User } from '@/models/User';
import { hashPassword, verifyPassword } from '@/lib/passwords';
import {
  invalidateCurrentSessionCache,
  primeCurrentSessionCache,
} from '@/lib/current-session-cache';
import { buildSessionCookie, createSessionToken } from '@/lib/session';
import { changePasswordSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import type { ChangePasswordResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

interface LeanPasswordUser {
  passwordHash?: string;
  sessionVersion?: number;
}

/**
 * Cambio de contraseña del propio usuario.
 *
 * Verifica la contraseña actual, guarda el nuevo hash (bcrypt 10), incrementa
 * `sessionVersion` para invalidar cualquier otra sesión y reemite la cookie del
 * usuario actual para que esta pestaña siga autenticada.
 */
export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, changePasswordSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { currentPassword, newPassword } = parsedBody.data;

    await dbConnect();

    const user = await User.findById(auth.session.userId)
      .select('passwordHash sessionVersion')
      .lean<LeanPasswordUser | null>();

    if (!user?.passwordHash) {
      return clearSessionCookie(errorResponse('Sesión inválida', 401));
    }

    const isCurrentPasswordValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      return errorResponse('La contraseña actual es incorrecta', 400);
    }

    const passwordHash = await hashPassword(newPassword);
    const updated = await User.findByIdAndUpdate(
      auth.session.userId,
      {
        $set: { passwordHash },
        $inc: { sessionVersion: 1 },
      },
      { new: true, runValidators: true },
    )
      .select('sessionVersion')
      .lean<{ sessionVersion?: number } | null>();

    if (!updated) {
      return clearSessionCookie(errorResponse('Sesión inválida', 401));
    }

    const sessionVersion =
      typeof updated.sessionVersion === 'number'
        ? updated.sessionVersion
        : auth.session.sessionVersion + 1;

    invalidateCurrentSessionCache(auth.session.userId);
    primeCurrentSessionCache({
      userId: auth.session.userId,
      username: auth.session.username,
      role: auth.session.role,
      active: true,
      sessionVersion,
      notificationsEnabled: auth.currentUser?.notificationsEnabled !== false,
    });

    const token = createSessionToken({
      userId: auth.session.userId,
      username: auth.session.username,
      role: auth.session.role,
      sessionVersion,
    });

    const responseBody: ChangePasswordResponse = {
      success: true,
      message: 'Contraseña actualizada exitosamente',
    };
    const response = NextResponse.json(responseBody);
    const cookie = buildSessionCookie(token);
    response.cookies.set(cookie.name, cookie.value, cookie.options);

    return response;
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al cambiar la contraseña:' });
  }
});
