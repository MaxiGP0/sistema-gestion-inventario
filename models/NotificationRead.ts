import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/**
 * Estado de lectura de una notificación para un usuario concreto.
 *
 * Las notificaciones se dirigen a un rol (depósito, facturación o global), por
 * lo que varios usuarios comparten la misma notificación. El estado leído no
 * puede vivir en `Notification` (sería global): se guarda una fila por usuario
 * y notificación. `dismissedAt` permite que "Limpiar leídas" o el borrado de
 * una notificación solo afecten la bandeja del usuario que lo solicita.
 */
export interface INotificationRead extends Document {
  userId: Types.ObjectId;
  notificationId: Types.ObjectId;
  readAt: Date;
  dismissedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationReadSchema = new Schema<INotificationRead>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    notificationId: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
    readAt: { type: Date, required: true },
    dismissedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Una sola fila por usuario/notificación: los upserts de "marcar como leída"
// no pueden duplicar el estado. El prefijo userId también cubre el listado.
NotificationReadSchema.index({ userId: 1, notificationId: 1 }, { unique: true });
// Limpieza al borrar una notificación (p. ej. al hard-delete de un pedido).
NotificationReadSchema.index({ notificationId: 1 });

export const NotificationRead: Model<INotificationRead> =
  mongoose.models.NotificationRead ||
  mongoose.model<INotificationRead>('NotificationRead', NotificationReadSchema);
