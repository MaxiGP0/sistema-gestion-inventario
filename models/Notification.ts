import mongoose, { Schema, Document, Model } from 'mongoose';

export interface INotification extends Document {
  title: string;
  message: string;
  targetRole: 'deposit' | 'billing' | 'vendor' | 'all';
  /**
   * Destinatario individual dentro de una bandeja privada (hoy `vendor`).
   * Las alertas de depósito/facturación siguen siendo compartidas por rol.
   */
  targetUserId?: mongoose.Types.ObjectId;
  /** Fallback para pedidos históricos sin `createdById`. */
  targetUsername?: string;
  orderId?: mongoose.Types.ObjectId;
  createdAt: Date;
}

/**
 * Retención de notificaciones compartidas.
 *
 * MongoDB elimina los documentos cuando `createdAt` supera esta edad. El
 * monitor TTL corre aproximadamente cada 60 segundos, así que la baja efectiva
 * puede demorar hasta un minuto más. Los estados `NotificationRead` quedan
 * huérfanos y se limpian con `scripts/cleanup-notification-reads.ts`
 * (ver docs/notificaciones-retencion.md).
 */
export const NOTIFICATION_RETENTION_DAYS = 180;
export const NOTIFICATION_RETENTION_SECONDS = NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60;

/**
 * Notificación de una bandeja. Las de depósito/facturación son compartidas por
 * rol; las de `vendor` son privadas y llevan `targetUserId`/`targetUsername`.
 * El estado leído es por usuario y vive en `NotificationRead` (modelo aparte),
 * no en este documento. El campo legacy `read` de documentos viejos se ignora
 * al listar.
 */
const NotificationSchema = new Schema<INotification>({
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  targetRole: { type: String, enum: ['deposit', 'billing', 'vendor', 'all'], default: 'all' },
  targetUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  targetUsername: { type: String, trim: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  createdAt: { type: Date, default: Date.now },
});

// Listados paginados por cursor (orden createdAt/_id descendente). El
// compuesto cubre el filtro por targetRole y el simple el listado global.
// El compuesto no sirve para el global porque targetRole es su prefijo.
NotificationSchema.index({ targetRole: 1, createdAt: -1, _id: -1 });
// Bandeja privada del vendedor: filtra por destinatario individual y mantiene
// el orden del cursor sin sort en memoria.
NotificationSchema.index({ targetRole: 1, targetUserId: 1, createdAt: -1, _id: -1 });
NotificationSchema.index({ createdAt: -1, _id: -1 });

// Retención: TTL de 180 días. Debe ser un índice de un solo campo, por eso no
// se puede aplicar sobre los compuestos de listado.
NotificationSchema.index(
  { createdAt: 1 },
  {
    name: 'notification_retention_ttl',
    expireAfterSeconds: NOTIFICATION_RETENTION_SECONDS,
  },
);

export const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
