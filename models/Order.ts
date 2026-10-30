import mongoose, { Schema, Document, Model } from 'mongoose';
import { ORDER_STATUSES, type OrderStatus } from '../lib/order-statuses';
import { POST_CONTROL_VALUES, type PostControl } from '../lib/order-post-control';
import {
  INVOICE_TYPES,
  PAYMENT_CONDITIONS,
  type InvoiceType,
  type PaymentCondition,
} from '../lib/order-commercial';
import './Product';
import './Client';
import { orderShortId } from '../lib/order-short-id';
import { buildOrderSearchFields } from '../lib/search-normalize';
import { applySearchFields } from '../lib/search-schema';

export interface IOrderComment {
  text: string;
  author?: string;
  role?: string;
  createdAt: Date;
}

export interface IOrderItem {
  productId: mongoose.Types.ObjectId;
  // Snapshots del catálogo al momento del pedido: permiten mostrar la línea
  // aunque el producto se haya eliminado y no haya populate disponible.
  productCode?: string;
  productName?: string;
  brandName?: string;
  unitPrice: number; // Snapshot del precio al momento del pedido
  requestedQuantity: number;
  verifiedQuantity: number;
  isPending: boolean; // Backorder / Paralizado
  /** Motivo/estado de la línea cuando queda pendiente o se elimina en depósito. */
  pendingReason?: string;
  /** Control post-facturación de la línea; `pendiente` bloquea la entrega. */
  postControl: PostControl;
  itemDiscount: number;
  lineTotal: number;
}

export interface IOrder extends Document {
  clientId: mongoose.Types.ObjectId;
  // Snapshots del cliente al momento del pedido (fallback del populate).
  clientName?: string;
  clientCode?: string;
  /** Últimos 6 caracteres del _id en minúsculas, denormalizados para buscar. */
  shortId: string;
  /** Palabras únicas normalizadas de cliente, vendedor, código corto e ítems. */
  searchTokens: string[];
  status: OrderStatus;
  items: IOrderItem[];
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  createdBy: string;
  /** Usuario de la sesión que creó el pedido; ausente en pedidos históricos. */
  createdById?: mongoose.Types.ObjectId;
  /**
   * Clave idempotente generada por el cliente para el alta o la duplicación.
   * Un reintento con la misma clave del mismo usuario devuelve el pedido ya
   * creado en lugar de insertar otro.
   */
  clientRequestId?: string;
  comments: IOrderComment[];
  archived: boolean;
  /**
   * Tipo de factura (A/B) pactado en el alta. Es opcional en Mongoose para no
   * romper el guardado de picking de pedidos históricos; `createOrderSchema`
   * lo exige al crear.
   */
  invoiceType?: InvoiceType;
  /**
   * Condición de pago pactada en el alta. Es opcional en Mongoose para no
   * romper el guardado de picking de pedidos históricos; `createOrderSchema`
   * la exige al crear.
   */
  paymentCondition?: PaymentCondition;
  /** Detalle libre cuando la condición es `otro` (máximo 120 caracteres). */
  paymentConditionDetail?: string;
  /**
   * Versión optimista del pedido. La administra Mongoose (versionKey) y se
   * incrementa en cada save() exitoso; los PUT deben enviar la versión leída
   * para detectar ediciones concurrentes.
   */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const OrderCommentSchema = new Schema<IOrderComment>({
  text: { type: String, required: true },
  author: { type: String },
  role: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const OrderItemSchema = new Schema<IOrderItem>({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: { type: String },
  productName: { type: String },
  brandName: { type: String },
  unitPrice: { type: Number, required: true },
  requestedQuantity: { type: Number, required: true, min: 0 },
  verifiedQuantity: { type: Number, default: 0, min: 0 },
  isPending: { type: Boolean, default: false },
  pendingReason: { type: String, trim: true },
  postControl: {
    type: String,
    enum: [...POST_CONTROL_VALUES],
    default: 'pendiente',
  },
  itemDiscount: { type: Number, default: 0 },
  lineTotal: { type: Number, required: true, default: 0 },
});

const OrderSchema = new Schema<IOrder>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    clientName: { type: String },
    clientCode: { type: String },
    // Denormalizado para que la búsqueda por #xxxxxx use un índice propio; los
    // pedidos históricos sin este campo caen al fallback por _id.
    shortId: { type: String, trim: true, lowercase: true },
    // Clave multikey compartida con Clientes/Productos: permite buscar por
    // prefijo de cliente, vendedor, código, producto o marca de cualquier línea.
    searchTokens: { type: [String], default: [] },
    status: {
      type: String,
      enum: [...ORDER_STATUSES],
      default: 'borrador',
    },
    items: [OrderItemSchema],
    subtotal: { type: Number, required: true, default: 0 },
    totalDiscount: { type: Number, required: true, default: 0 },
    finalTotal: { type: Number, required: true, default: 0 },
    createdBy: { type: String, required: true },
    // Opcional para no romper pedidos históricos; el alta nueva siempre lo setea.
    createdById: { type: Schema.Types.ObjectId, ref: 'User' },
    // Opcional: sólo lo envían las operaciones idempotentes (duplicar).
    clientRequestId: { type: String, trim: true, maxlength: 120 },
    comments: [OrderCommentSchema],
    archived: { type: Boolean, default: false },
    invoiceType: { type: String, enum: [...INVOICE_TYPES] },
    paymentCondition: { type: String, enum: [...PAYMENT_CONDITIONS] },
    paymentConditionDetail: { type: String, trim: true, maxlength: 120 },
  },
  {
    timestamps: true,
    // Control de concurrencia optimista: save() filtra por `version` y falla
    // con VersionError si otro proceso guardó antes. El PUT traduce ese error
    // a un 409 con mensaje de recarga.
    versionKey: 'version',
    optimisticConcurrency: true,
  },
);

// Los listados se ordenan por { createdAt: -1, _id: -1 } para que la paginación
// por cursor tenga un orden total y estable. `_id` forma parte del índice para
// que Mongo resuelva filtro + orden sin una etapa de sort en memoria.
OrderSchema.index({ status: 1, createdAt: -1, _id: -1 });
OrderSchema.index({ clientId: 1, createdAt: -1, _id: -1 });
// "Mis pedidos": el vendedor filtra por creador y ordena por el cursor.
OrderSchema.index({ createdById: 1, createdAt: -1, _id: -1 });
// Reintentos idempotentes: una misma clave de un usuario no puede crear dos
// pedidos. El índice parcial deja convivir todos los pedidos sin clave.
OrderSchema.index(
  { createdById: 1, clientRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRequestId: { $type: 'string' } },
  },
);
// Listado por bandeja: archived es el filtro fijo y status llega como $in.
OrderSchema.index({ archived: 1, status: 1, createdAt: -1, _id: -1 });
// `archived + fecha` sin estado: el compuesto anterior no puede usarlo porque
// `status` queda entre los dos campos y corta el rango de createdAt.
OrderSchema.index({ archived: 1, createdAt: -1, _id: -1 });
OrderSchema.index({ createdAt: -1, _id: -1 });
OrderSchema.index({ 'items.productId': 1 });
// Búsqueda por código corto (#xxxxxx): índice directo sobre el campo
// denormalizado. El fallback de pedidos históricos se resuelve por _id.
OrderSchema.index({ shortId: 1 });
// Búsqueda de pedidos por prefijo: `archived` es el filtro fijo de las bandejas,
// `searchTokens` es multikey (cliente, vendedor, código e ítems) y el resto
// mantiene el orden del cursor sin SORT en memoria. Reemplaza al índice `$text`
// `order_search_text`, que no soporta prefijos.
OrderSchema.index({ archived: 1, searchTokens: 1, createdAt: -1, _id: -1 });

// `_id` se genera antes de validar/salvar: el código corto siempre queda
// sincronizado en altas normales. `insertMany` no ejecuta pre('validate') en
// todas las versiones, por eso también se completa en su middleware.
OrderSchema.pre('validate', function () {
  if (this._id) this.shortId = orderShortId(this._id);
  applySearchFields(this, buildOrderSearchFields);
});

OrderSchema.pre('insertMany', function (docs: Array<Record<string, any>>) {
  for (const doc of docs) {
    if (!doc._id) doc._id = new mongoose.Types.ObjectId();
    doc.shortId = orderShortId(doc._id);
    applySearchFields(doc, buildOrderSearchFields);
  }
});

export const Order: Model<IOrder> =
  mongoose.models.Order || mongoose.model<IOrder>('Order', OrderSchema);
