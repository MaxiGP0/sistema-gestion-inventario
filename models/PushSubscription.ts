import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/**
 * Suscripción Web Push de un dispositivo.
 *
 * Un usuario puede tener varias filas (una por navegador/dispositivo). El
 * `endpoint` es único en toda la colección: identifica al navegador y, si otra
 * persona inicia sesión en el mismo dispositivo, la suscripción se reasigna al
 * usuario nuevo en vez de duplicarse. Las claves `p256dh`/`auth` son las que
 * usa el servidor para cifrar el payload; nunca se envían a otros usuarios.
 */
export interface IPushSubscription extends Document {
  userId: Types.ObjectId;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

const PushSubscriptionKeysSchema = new Schema(
  {
    p256dh: { type: String, required: true, trim: true },
    auth: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const PushSubscriptionSchema = new Schema<IPushSubscription>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  endpoint: { type: String, required: true, trim: true },
  keys: { type: PushSubscriptionKeysSchema, required: true },
  userAgent: { type: String, trim: true, maxlength: 500, default: null },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now },
});

// Un endpoint pertenece a un único documento. El índice único también evita
// duplicados cuando dos pestañas registran la misma suscripción a la vez.
PushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });
// Listado y revocación de los dispositivos de un usuario.
PushSubscriptionSchema.index({ userId: 1 });

export const PushSubscription: Model<IPushSubscription> =
  mongoose.models.PushSubscription ||
  mongoose.model<IPushSubscription>('PushSubscription', PushSubscriptionSchema);
