/** Lectura y serialización de usuarios administrables (sin passwordHash). */
import dbConnect from './mongodb';
import { User } from '@/models/User';
import { resolveUserRole } from './authz';
import type { UserDTO } from './types';

/** Campos que puede ver el backoffice; nunca incluye el hash de contraseña. */
export const USER_ADMIN_PROJECTION =
  'username role active lastLoginAt notificationsEnabled createdAt';

interface LeanUser {
  _id: unknown;
  username?: string;
  role?: unknown;
  active?: boolean;
  lastLoginAt?: Date | string | null;
  notificationsEnabled?: boolean;
  createdAt?: Date | string | null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** DTO homogéneo para la API y el Server Component del backoffice. */
export function toUserDTO(user: LeanUser): UserDTO {
  return {
    id: String(user._id),
    username: user.username ?? '',
    role: resolveUserRole(user.role, user.username),
    // `active` ausente en documentos históricos equivale a activo.
    active: user.active !== false,
    notificationsEnabled: user.notificationsEnabled !== false,
    lastLoginAt: toIsoString(user.lastLoginAt),
    createdAt: toIsoString(user.createdAt),
  };
}

/** Lista completa para el backoffice, ordenada por nombre de usuario. */
export async function listUsers(): Promise<UserDTO[]> {
  await dbConnect();

  const users = await User.find({})
    .select(USER_ADMIN_PROJECTION)
    .sort({ username: 1 })
    .lean<LeanUser[]>();

  return users.map(toUserDTO);
}
