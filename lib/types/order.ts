import type { OrderStatus } from '../order-statuses';
import type { PostControl } from '../order-post-control';
import type { InvoiceType, PaymentCondition } from '../order-commercial';
import type { ApiMessageResponse, CursorPagination, PagePagination } from './common';

/** Comentario/observación de una etapa del pedido. */
export interface OrderCommentDTO {
  _id?: string;
  text: string;
  author?: string;
  role?: string;
  createdAt: string;
}

/** Cliente embebido en el listado liviano de pedidos (populate parcial). */
export interface OrderClientSummaryDTO {
  /** Presente en el JSON de Mongoose aunque la proyección no lo enumere. */
  _id?: string;
  code?: string;
  name?: string;
  localidad?: string;
  province?: string;
}

/** Cliente embebido en el detalle del pedido (populate completo). */
export interface OrderClientDTO {
  _id?: string;
  code: string;
  name: string;
  address: string;
  localidad?: string;
  province?: string;
  /** Descuentos vigentes de la ficha, usados al precargar o editar un pedido. */
  generalDiscount?: number;
  brandDiscounts?: {
    brandId: string | { _id: string; name?: string; codePrefix?: string };
    discountPercentage: number;
  }[];
}

/** Marca embebida en el producto poblado de una línea. */
export interface OrderItemBrandDTO {
  _id?: string;
  name: string;
  codePrefix?: string;
}

/** Producto poblado de una línea del pedido. */
export interface OrderItemProductDTO {
  _id: string;
  code: string;
  name: string;
  price: number;
  priceWithIva?: number;
  imageUrl?: string;
  /** Baja lógica: al precargar un pedido la línea se omite y se avisa. */
  active?: boolean;
  brandId?: OrderItemBrandDTO | null;
}

/**
 * Línea del pedido tal como la devuelve la API. Los campos `productCode`,
 * `productName` y `brandName` son snapshots del alta: siguen disponibles
 * aunque el producto se haya eliminado y el populate devuelva `null`.
 */
export interface OrderItemDTO {
  _id: string;
  productCode?: string;
  productName?: string;
  brandName?: string;
  productId?: OrderItemProductDTO | null;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity: number;
  isPending: boolean;
  pendingReason?: string;
  /** Control post-facturación; los pedidos históricos no lo traen. */
  postControl?: PostControl;
  itemDiscount: number;
  lineTotal: number;
}

/** Pedido completo de `GET /api/orders/[id]`. */
export interface OrderDTO {
  _id: string;
  clientId?: OrderClientDTO | null;
  /** Snapshots del cliente: fallback si el populate devuelve `null`. */
  clientName?: string;
  clientCode?: string;
  status: OrderStatus;
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  createdBy: string;
  /** Usuario creador; ausente en pedidos históricos. */
  createdById?: string;
  /** Clave idempotente del alta o duplicación; ausente en pedidos históricos. */
  clientRequestId?: string;
  createdAt: string;
  /** Opcionales en pedidos históricos; el alta nueva siempre los informa. */
  invoiceType?: InvoiceType;
  paymentCondition?: PaymentCondition;
  paymentConditionDetail?: string;
  /** Versión optimista para los PUT (se incrementa en cada guardado). */
  version?: number;
  archived?: boolean;
  items: OrderItemDTO[];
  comments?: OrderCommentDTO[];
}

/**
 * Línea del listado liviano: snapshots, cantidades y la referencia escalar al
 * producto. `productId` nunca viene poblado ni incluye importes por línea, pero
 * alcanza para repetir el pedido sin un segundo GET del detalle.
 */
export interface OrderSummaryItemDTO {
  _id?: string;
  productId?: string | null;
  productName?: string;
  productCode?: string;
  requestedQuantity?: number;
  verifiedQuantity?: number;
  isPending?: boolean;
  pendingReason?: string;
}

/**
 * Pedido del listado liviano de las bandejas. Conserva el cliente reducido,
 * los totales, el contexto comercial y el último comentario. Los ítems llegan
 * proyectados a sus snapshots, sin poblar `items.productId`.
 */
export interface OrderSummaryDTO {
  _id: string;
  clientId?: OrderClientSummaryDTO | null;
  clientName?: string;
  clientCode?: string;
  status: string;
  finalTotal: number;
  createdBy: string;
  createdAt: string;
  version?: number;
  archived?: boolean;
  invoiceType?: InvoiceType;
  paymentCondition?: PaymentCondition;
  /** Detalle de "Otro"; permite repetir el pedido sin el GET del detalle. */
  paymentConditionDetail?: string;
  /** Sólo el último comentario: el listado no transporta el historial completo. */
  comments?: OrderCommentDTO[];
  items: OrderSummaryItemDTO[];
}

/** `GET /api/orders` en modo cursor. */
export interface OrderCursorListResponse {
  success: true;
  orders: OrderSummaryDTO[];
  pagination: CursorPagination;
}

/** `GET /api/orders` en modo página (`page`/`limit`). */
export interface OrderListResponse {
  success: true;
  orders: OrderSummaryDTO[];
  pagination: PagePagination;
}

/** `GET /api/orders/[id]` */
export interface OrderDetailResponse {
  success: true;
  order: OrderDTO;
}

/** `POST /api/orders` y `PUT /api/orders/[id]`. */
export interface OrderMutationResponse extends ApiMessageResponse {
  order: OrderDTO;
  /** `true` cuando un alta repitió una clave idempotente ya procesada. */
  deduplicated?: boolean;
}

/**
 * `PATCH /api/orders/[id]/post-control`.
 *
 * La UI solo necesita la versión nueva y el control de cada línea; devolver el
 * pedido completo obligaba a poblar cliente y productos en cada toque.
 */
export interface OrderPostControlResponse extends ApiMessageResponse {
  order: {
    _id: string;
    status: OrderStatus;
    version: number;
    items: Array<{ _id: string; postControl: PostControl }>;
  };
}

/** Línea omitida al duplicar porque el producto está inactivo o no existe. */
export interface DuplicateOmittedItemDTO {
  productId: string;
  productCode?: string;
  productName?: string;
  requestedQuantity: number;
  reason: 'inactive' | 'not_found';
}

/** `POST /api/orders/[id]/duplicate`. */
export interface OrderDuplicateResponse extends OrderMutationResponse {
  /** Detalle de las líneas que no se pudieron copiar. */
  omittedItems: DuplicateOmittedItemDTO[];
  /** `true` cuando el request repitió una clave idempotente ya procesada. */
  deduplicated?: boolean;
}
