import mongoose, { Schema, Document, Model } from 'mongoose';
import { USER_ROLES, type UserRole } from '../lib/authz';

export interface IUser extends Document {
  username: string;
  passwordHash: string;
  role: UserRole;
  /** Un usuario desactivado conserva sus datos pero no puede operar. */
  active: boolean;
  /** Último login exitoso; `null`/ausente en usuarios que nunca ingresaron. */
  lastLoginAt?: Date | null;
  /**
   * Versión de la sesión. Se incluye en la cookie firmada y se incrementa al
   * resetear/cambiar la contraseña o al reactivar un usuario para invalidar
   * las sesiones anteriores.
   */
  sessionVersion: number;
  notificationsEnabled: boolean;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  // El default cubre altas nuevas; para usuarios viejos sin rol se aplica la
  // migración suave de lib/authz.resolveUserRole (admin histórico => admin).
  role: { type: String, enum: [...USER_ROLES], default: 'vendedor' },
  // `active` ausente en documentos históricos se interpreta como activo.
  active: { type: Boolean, default: true },
  lastLoginAt: { type: Date, default: null },
  // `sessionVersion` ausente en documentos/tokens históricos equivale a 0.
  sessionVersion: { type: Number, default: 0, min: 0 },
  notificationsEnabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
