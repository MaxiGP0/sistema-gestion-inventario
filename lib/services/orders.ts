/**
 * Capa de dominio de pedidos.
 *
 * Las funciones de cálculo de este módulo son puras: reciben datos ya
 * consultados (cliente, catálogo, pedido existente) y devuelven un plan con lo
 * que hay que persistir/notificar, o un error tipado. No importan mongoose ni
 * Next, así que se pueden probar sin base de datos ni mocks de la capa HTTP
 * (`scripts/test-order-service.ts`). `applyOrderUpdatePlan` solo vuelca el plan
 * sobre el documento, sin I/O.
 *
 * Las rutas (`app/api/orders/**`) quedan como adaptadores: autentican, validan
 * el body con Zod, consultan la base y traducen el resultado a una respuesta
 * HTTP. Las reglas comerciales viven acá.
 */

import {
  brandIdToString,
  buildClientDiscountResolver,
  type ClientDiscountConfigLike,
} from '../discounts';
import { roundCurrency } from '../money';
import { productSnapshotOf } from '../order-snapshots';
import {
  hasUncontrolledPostItems,
  isPostControlPending,
  type PostControl,
} from '../order-post-control';
import { getOrderStatusTransitionError, type OrderStatus } from '../order-statuses';
import {
  isInvoiceType,
  isPaymentCondition,
  type InvoiceType,
  type PaymentCondition,
} from '../order-commercial';
import {
  applyVerifiedTotals,
  hasPendingOrderItems,
  matchesOrderItem,
  PENDING_REASON_REMOVED,
  resolveItemValues,
} from '../order-totals';
import { buildOrderSearchFields } from '../search-normalize';

/** Mismos mensajes/códigos que consumen la UI y los tests de la API. */
export const PENDING_ITEMS_BLOCK_ERROR =
  'No se puede pasar el pedido a facturación: hay ítems pendientes o cantidades sin verificar.';

export const UNCONTROLLED_POST_ITEMS_BLOCK_ERROR =
  'No se puede marcar el pedido como entregado: quedan líneas sin controlar en el control post-factura.';

export const ORDER_VERSION_CONFLICT_ERROR =
  'Conflicto de versión: el pedido fue modificado por otro usuario. Recargá el pedido y volvé a intentarlo.';

export const ORDER_VERSION_CONFLICT_CODE = 'ORDER_VERSION_CONFLICT';

/**
 * La edición integral de un borrador se rechaza cuando depósito ya empezó a
 * controlar líneas, registró control post-factura o el pedido cambió de estado.
 */
export const DRAFT_EDIT_BLOCKED_ERROR =
  'El pedido ya no puede editarse: depósito lo tomó o cambió de estado. Recargá el pedido para ver su estado actual.';

export const DRAFT_EDIT_INVALID_ITEMS_ERROR =
  'La edición del borrador debe incluir al menos un producto con cantidad mayor a 0.';

export const DRAFT_EDIT_INACTIVE_PRODUCT_ERROR =
  'El borrador incluye productos inactivos o inexistentes. Quitalos del carrito antes de guardar.';

/** Estados en los que se registra el control post-factura por línea. */
export const POST_CONTROL_STATUSES: readonly OrderStatus[] = [
  'facturacion',
  'control_post_factura',
];

// ---------------------------------------------------------------------------
// Resultado tipado (sin excepciones ni tipos de Next)
// ---------------------------------------------------------------------------

export interface OrderServiceError {
  ok: false;
  status: number;
  message: string;
  code?: string;
  extras?: Record<string, unknown>;
}

export type OrderServiceResult<T> = { ok: true; value: T } | OrderServiceError;

/** Campos extra de la respuesta HTTP (`code`, `version`, ...) sin Next. */
export function orderErrorBody(error: OrderServiceError): Record<string, unknown> {
  return {
    ...(error.code ? { code: error.code } : {}),
    ...error.extras,
  };
}

function failure(
  status: number,
  message: string,
  options: { code?: string; extras?: Record<string, unknown> } = {},
): OrderServiceError {
  return { ok: false, status, message, ...options };
}

/** Conflicto de escritura concurrente: el cliente leyó una versión anterior. */
export function orderVersionConflict(currentVersion?: number): OrderServiceError {
  return failure(409, ORDER_VERSION_CONFLICT_ERROR, {
    code: ORDER_VERSION_CONFLICT_CODE,
    extras: currentVersion !== undefined ? { version: currentVersion } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Tipos compartidos (estructurales: sirven para documentos y proyecciones)
// ---------------------------------------------------------------------------

export interface ClientSnapshotSource extends ClientDiscountConfigLike {
  code?: string | null;
  name?: string | null;
}

export interface CatalogProductInput {
  /** ObjectId o string según venga del documento o de una proyección. */
  _id?: any;
  code?: string;
  name?: string;
  price: number;
  /** ObjectId de marca o documento poblado ({ name }). */
  brandId?: unknown;
  /** Baja lógica: al duplicar, las líneas de productos inactivos se omiten. */
  active?: boolean;
}

export interface OrderCommentInput {
  text: string;
  author?: string;
  role?: string;
  createdAt: Date;
}

export interface CreateOrderItemInput {
  productId: string;
  requestedQuantity: number;
  customDiscount?: number;
}

export interface DraftOrderItem {
  /** ObjectId del producto (se persiste tal como vino del catálogo). */
  productId: any;
  productCode?: string;
  productName?: string;
  brandName?: string;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity: number;
  isPending: boolean;
  postControl: 'pendiente';
  itemDiscount: number;
  lineTotal: number;
}

export interface OrderDraft {
  clientId: string;
  clientName?: string;
  clientCode?: string;
  status: 'borrador';
  items: DraftOrderItem[];
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  createdBy: string;
  /** Usuario de la sesión creadora; opcional para pedidos históricos. */
  createdById?: string;
  /** Clave idempotente del cliente para reintentos sin duplicar. */
  clientRequestId?: string;
  comments: OrderCommentInput[];
  archived: false;
  invoiceType: InvoiceType;
  paymentCondition: PaymentCondition;
  paymentConditionDetail?: string;
  version: 0;
}

export interface ExistingOrderItemInput {
  _id?: unknown;
  productId: unknown;
  productCode?: string;
  productName?: string;
  brandName?: string;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity?: number;
  isPending?: boolean;
  pendingReason?: string;
  postControl?: PostControl;
  itemDiscount?: number;
  lineTotal?: number;
}

export interface ExistingOrderInput {
  version?: number;
  status: OrderStatus;
  items: readonly ExistingOrderItemInput[];
  clientName?: string;
  clientCode?: string;
  comments?: readonly OrderCommentInput[];
  /** Vendedor titular; se usa para dirigir sus alertas privadas. */
  createdBy?: string;
  /** Id de la sesión creadora (ObjectId o string según el origen). */
  createdById?: string | { toString(): string } | null;
}

export interface IncomingOrderItemInput {
  _id?: string;
  productId?: string;
  requestedQuantity?: number;
  verifiedQuantity?: number;
  isPending?: boolean;
  pendingReason?: string;
  customDiscount?: number;
}

/**
 * ¿El pedido sigue siendo un borrador intacto? Es la condición para que el
 * vendedor titular (o un admin) pueda reemplazar sus ítems y datos comerciales.
 */
export function isDraftOrderIntact(order: {
  status: string;
  items: readonly { verifiedQuantity?: number; postControl?: PostControl }[];
}): boolean {
  if (order.status !== 'borrador') return false;

  return order.items.every(
    (item) =>
      (item.verifiedQuantity ?? 0) === 0 && isPostControlPending({ postControl: item.postControl }),
  );
}

export interface PlannedOrderItem {
  _id?: unknown;
  productId: unknown;
  productCode?: string;
  productName?: string;
  brandName?: string;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity: number;
  isPending: boolean;
  pendingReason?: string;
  postControl: PostControl;
  itemDiscount: number;
  lineTotal: number;
}

// ---------------------------------------------------------------------------
// Notificaciones (payload puro; el route las persiste/emite)
// ---------------------------------------------------------------------------

export interface OrderNotificationDraft {
  title: string;
  message: string;
  targetRole: 'deposit' | 'billing' | 'vendor' | 'all';
  /** Destinatario individual de la bandeja privada del vendedor. */
  targetUserId?: string;
  /** Fallback por usuario para pedidos históricos sin createdById. */
  targetUsername?: string;
}

export function buildDraftOrderNotification(input: {
  createdBy: string;
  clientName: string;
  finalTotal: number;
}): OrderNotificationDraft {
  return {
    title: 'Nuevo Pedido (Borrador)',
    message: `El vendedor ${input.createdBy} creó un pedido para ${input.clientName} por $${input.finalTotal.toFixed(2)}`,
    targetRole: 'deposit',
  };
}

export function buildReadyForBillingNotification(input: {
  clientName: string;
}): OrderNotificationDraft {
  return {
    title: 'Pedido Listo para Facturar',
    message: `El pedido de ${input.clientName} ha sido verificado en depósito y está listo para facturar.`,
    targetRole: 'billing',
  };
}

/**
 * Aviso a depósito cuando el vendedor responde en un pedido que sigue activo
 * en su etapa (borrador o paralizado): el comentario suele destrabar stock,
 * faltantes o una espera acordada con el cliente.
 */
export function buildVendorCommentNotification(input: {
  author: string;
  clientName: string;
  comment: string;
}): OrderNotificationDraft {
  return {
    title: 'Nuevo comentario en pedido',
    message: `El vendedor ${input.author} comentó el pedido de ${input.clientName}: ${input.comment}`,
    targetRole: 'deposit',
  };
}

/** Campos de destinatario individual para la bandeja privada del vendedor. */
function vendorNotificationTarget(input: {
  createdById?: string | null;
  createdBy?: string | null;
}): Pick<OrderNotificationDraft, 'targetUserId' | 'targetUsername'> {
  return {
    ...(input.createdById ? { targetUserId: String(input.createdById) } : {}),
    ...(input.createdBy ? { targetUsername: input.createdBy } : {}),
  };
}

/**
 * Aviso privado al vendedor titular cuando depósito paraliza su pedido.
 * El motivo puede venir del comentario del PUT o de la primera línea pendiente.
 */
export function buildVendorParalyzedNotification(input: {
  createdById?: string | null;
  createdBy?: string | null;
  clientName: string;
  reason?: string | null;
}): OrderNotificationDraft {
  const reason = input.reason?.trim();

  return {
    title: 'Pedido Paralizado en Depósito',
    message: `El pedido de ${input.clientName} quedó paralizado en depósito${
      reason ? `: ${reason}` : '.'
    }`,
    targetRole: 'vendor',
    ...vendorNotificationTarget(input),
  };
}

/** Aviso privado al vendedor titular cuando facturación marca el pedido entregado. */
export function buildVendorDeliveredNotification(input: {
  createdById?: string | null;
  createdBy?: string | null;
  clientName: string;
}): OrderNotificationDraft {
  return {
    title: 'Pedido Entregado',
    message: `El pedido de ${input.clientName} fue entregado.`,
    targetRole: 'vendor',
    ...vendorNotificationTarget(input),
  };
}

/** Comentario de un rol operativo en el pedido del vendedor titular. */
export function buildVendorOrderCommentNotification(input: {
  createdById?: string | null;
  createdBy?: string | null;
  author: string;
  clientName: string;
  comment: string;
}): OrderNotificationDraft {
  return {
    title: 'Nuevo comentario en tu pedido',
    message: `${input.author} comentó tu pedido de ${input.clientName}: ${input.comment}`,
    targetRole: 'vendor',
    ...vendorNotificationTarget(input),
  };
}

// ---------------------------------------------------------------------------
// Alta de pedidos
// ---------------------------------------------------------------------------

export interface CreateOrderDraftInput {
  clientId: string;
  client: ClientSnapshotSource | null | undefined;
  products: readonly CatalogProductInput[];
  items: readonly CreateOrderItemInput[];
  createdBy: string;
  /** Id de la sesión; el alta nueva siempre lo informa. */
  createdById?: string;
  /** Rol normalizado de la sesión para firmar el comentario inicial. */
  createdByRole?: string;
  comment?: string | null;
  /** Obligatorio al crear; lo valida `createOrderSchema` en la API. */
  invoiceType: InvoiceType;
  /** Obligatoria al crear; la valida `createOrderSchema` en la API. */
  paymentCondition: PaymentCondition;
  /** Solo se persiste cuando la condición es `otro`. */
  paymentConditionDetail?: string | null;
  /** Clave idempotente del cliente; permite reintentar sin crear otro pedido. */
  clientRequestId?: string | null;
  now?: Date;
}

export interface CreateOrderPlan {
  order: OrderDraft;
  notification: OrderNotificationDraft;
}

/** Ids de catálogo que hay que consultar para armar el alta. */
export function collectRequestedProductIds(items: readonly CreateOrderItemInput[]): string[] {
  return [
    ...new Set(
      items
        .filter((item) => (Number(item.requestedQuantity) || 0) > 0)
        .map((item) => String(item.productId)),
    ),
  ];
}

/**
 * Arma el borrador del pedido: snapshots de cliente y líneas, descuento por
 * marca (o general) y totales con la misma fórmula que el picking.
 */
export function createOrderDraft(
  input: CreateOrderDraftInput,
): OrderServiceResult<CreateOrderPlan> {
  const { client, createdBy, createdById, createdByRole, comment, invoiceType, paymentCondition } =
    input;

  if (!client) {
    return failure(404, 'Cliente no encontrado en la base de datos');
  }

  const productById = new Map(input.products.map((product) => [String(product._id), product]));
  // Se precomputa una sola vez: el descuento por marca pisa al general y ante
  // marcas repetidas gana la primera coincidencia (sin find() por ítem).
  const discounts = buildClientDiscountResolver(client);

  const orderItems: DraftOrderItem[] = [];
  let subtotal = 0;
  let totalDiscount = 0;

  for (const item of input.items) {
    const requestedQuantity = Number(item.requestedQuantity) || 0;
    if (requestedQuantity <= 0) continue;

    const product = productById.get(String(item.productId));
    if (!product) continue;

    const unitPrice = product.price;
    const discountPercentage =
      item.customDiscount !== undefined
        ? discounts.normalize(item.customDiscount)
        : discounts.resolveForBrand(product.brandId);

    const gross = roundCurrency(unitPrice * requestedQuantity);
    const discountAmount = roundCurrency((gross * discountPercentage) / 100);

    subtotal = roundCurrency(subtotal + gross);
    totalDiscount = roundCurrency(totalDiscount + discountAmount);

    orderItems.push({
      productId: product._id,
      ...productSnapshotOf(product),
      unitPrice,
      requestedQuantity,
      verifiedQuantity: 0,
      isPending: false,
      postControl: 'pendiente',
      itemDiscount: discountPercentage,
      lineTotal: roundCurrency(gross - discountAmount),
    });
  }

  if (orderItems.length === 0) {
    return failure(400, 'Debe ingresar cantidades mayores a 0 en los productos');
  }

  const finalTotal = roundCurrency(subtotal - totalDiscount);
  const comments: OrderCommentInput[] =
    comment && comment.trim()
      ? [
          {
            text: comment.trim(),
            author: createdBy,
            role: createdByRole ?? 'vendedor',
            createdAt: input.now ?? new Date(),
          },
        ]
      : [];

  const paymentConditionDetail =
    paymentCondition === 'otro' && input.paymentConditionDetail?.trim()
      ? input.paymentConditionDetail.trim()
      : undefined;

  const order: OrderDraft = {
    clientId: input.clientId,
    clientName: client.name ?? undefined,
    clientCode: client.code ?? undefined,
    status: 'borrador',
    items: orderItems,
    subtotal,
    totalDiscount,
    finalTotal,
    createdBy,
    ...(createdById ? { createdById } : {}),
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    comments,
    archived: false,
    invoiceType,
    paymentCondition,
    ...(paymentConditionDetail ? { paymentConditionDetail } : {}),
    version: 0,
  };

  return {
    ok: true,
    value: {
      order,
      notification: buildDraftOrderNotification({
        createdBy,
        clientName: client.name ?? 'Cliente',
        finalTotal,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Duplicación de pedidos
// ---------------------------------------------------------------------------

export const DUPLICATE_NO_ITEMS_ERROR =
  'No se puede duplicar el pedido: no quedan productos activos para copiar.';
export const DUPLICATE_NO_COMMERCIAL_DATA_ERROR =
  'El pedido original no tiene tipo de factura o condición de pago válidos. Completá esos datos en un pedido nuevo.';

export interface DuplicateOrderSourceItem {
  productId: unknown;
  requestedQuantity?: number;
  productCode?: string;
  productName?: string;
}

export interface DuplicateOrderSource {
  clientId: string;
  items: readonly DuplicateOrderSourceItem[];
  invoiceType?: unknown;
  paymentCondition?: unknown;
  paymentConditionDetail?: string | null;
}

export type DuplicateOmittedReason = 'inactive' | 'not_found';

/** Línea del pedido original que no se pudo copiar, con el motivo para la UI. */
export interface DuplicateOmittedItem {
  productId: string;
  productCode?: string;
  productName?: string;
  requestedQuantity: number;
  reason: DuplicateOmittedReason;
}

export interface DuplicateOrderDraftInput {
  source: DuplicateOrderSource;
  client: ClientSnapshotSource | null | undefined;
  /** Catálogo actual, incluyendo inactivos para poder informar la omisión. */
  products: readonly CatalogProductInput[];
  createdBy: string;
  createdById?: string;
  createdByRole?: string;
  clientRequestId?: string | null;
  now?: Date;
}

export interface DuplicateOrderPlan extends CreateOrderPlan {
  omittedItems: DuplicateOmittedItem[];
}

/** Ids de catálogo del pedido origen que hay que consultar para duplicarlo. */
export function collectDuplicateProductIds(items: readonly DuplicateOrderSourceItem[]): string[] {
  return [
    ...new Set(
      items
        .filter((item) => (Number(item.requestedQuantity) || 0) > 0)
        .map((item) => brandIdToString(item.productId))
        .filter((productId): productId is string => Boolean(productId)),
    ),
  ];
}

/**
 * Arma el borrador de una copia del pedido: conserva cliente y cantidades
 * solicitadas, pero toma precio, snapshot y descuento vigentes del catálogo y
 * de la ficha actual del cliente. Las líneas inactivas o inexistentes se
 * omiten y se devuelven en `omittedItems`; si no queda ninguna, falla con 400.
 */
export function duplicateOrderDraft(
  input: DuplicateOrderDraftInput,
): OrderServiceResult<DuplicateOrderPlan> {
  const { source } = input;

  if (!isInvoiceType(source.invoiceType) || !isPaymentCondition(source.paymentCondition)) {
    return failure(400, DUPLICATE_NO_COMMERCIAL_DATA_ERROR);
  }

  const productById = new Map(input.products.map((product) => [String(product._id), product]));
  const omittedItems: DuplicateOmittedItem[] = [];
  const items: CreateOrderItemInput[] = [];

  for (const item of source.items) {
    const requestedQuantity = Number(item.requestedQuantity) || 0;
    if (requestedQuantity <= 0) continue;

    const productId = brandIdToString(item.productId) ?? String(item.productId ?? '');
    const product = productById.get(productId);

    if (!product) {
      omittedItems.push({
        productId,
        productCode: item.productCode,
        productName: item.productName,
        requestedQuantity,
        reason: 'not_found',
      });
      continue;
    }

    if (product.active === false) {
      omittedItems.push({
        productId,
        productCode: product.code ?? item.productCode,
        productName: product.name ?? item.productName,
        requestedQuantity,
        reason: 'inactive',
      });
      continue;
    }

    items.push({ productId, requestedQuantity });
  }

  if (items.length === 0) {
    return failure(400, DUPLICATE_NO_ITEMS_ERROR, {
      extras: { omittedItems },
    });
  }

  const draft = createOrderDraft({
    clientId: source.clientId,
    client: input.client,
    products: input.products,
    items,
    createdBy: input.createdBy,
    createdById: input.createdById,
    createdByRole: input.createdByRole,
    invoiceType: source.invoiceType,
    paymentCondition: source.paymentCondition,
    paymentConditionDetail: source.paymentConditionDetail,
    clientRequestId: input.clientRequestId,
    now: input.now,
  });
  if (!draft.ok) return draft;

  return {
    ok: true,
    value: {
      ...draft.value,
      omittedItems,
    },
  };
}

// ---------------------------------------------------------------------------
// Picking / edición de pedidos
// ---------------------------------------------------------------------------

export interface PlanOrderUpdateInput {
  order: ExistingOrderInput;
  /** Cliente poblado del pedido (config de descuentos vigente). */
  client?: ClientSnapshotSource | null;
  /** Productos del catálogo para las líneas nuevas (las consulta el route). */
  catalogProducts?: readonly CatalogProductInput[];
  items?: readonly IncomingOrderItemInput[];
  status?: OrderStatus;
  comment?: string;
  author?: string;
  role?: string;
  archived?: boolean;
  /** Versión que leyó el cliente; obligatoria para detectar escrituras pisadas. */
  version: number;
  /**
   * Edición integral de un borrador: reemplaza los ítems con precios y
   * descuentos vigentes sin pasar el pedido a picking.
   */
  draftEdit?: boolean;
  /** Datos comerciales ajustables en la edición del borrador. */
  invoiceType?: InvoiceType;
  paymentCondition?: PaymentCondition;
  paymentConditionDetail?: string | null;
  now?: Date;
}

export interface OrderUpdatePlan {
  clientName?: string;
  clientCode?: string;
  archived?: boolean;
  items?: PlannedOrderItem[];
  subtotal?: number;
  totalDiscount?: number;
  finalTotal?: number;
  status: OrderStatus;
  invoiceType?: InvoiceType;
  paymentCondition?: PaymentCondition;
  /** `null` limpia el detalle (por ejemplo, al pasar de "Otro" a "Contado"). */
  paymentConditionDetail?: string | null;
  comment?: OrderCommentInput;
  notification: OrderNotificationDraft | null;
}

/**
 * Ids de catálogo que el route debe consultar para las líneas nuevas del PUT.
 * Un ítem que matchea una línea existente conserva su precio/descuento snapshot.
 */
export function collectNewProductIds(
  order: Pick<ExistingOrderInput, 'items'>,
  items: readonly IncomingOrderItemInput[],
): string[] {
  return [
    ...new Set(
      items
        .filter(
          (updatedItem) => !order.items.some((existing) => matchesOrderItem(existing, updatedItem)),
        )
        .map((updatedItem) => updatedItem.productId)
        .filter((productId): productId is string => productId !== undefined),
    ),
  ];
}

function preservedRemovedItems(
  existingItems: readonly ExistingOrderItemInput[],
  incomingItems: readonly IncomingOrderItemInput[],
): PlannedOrderItem[] {
  return existingItems
    .filter(
      (existingItem) =>
        !incomingItems.some((updatedItem) => matchesOrderItem(existingItem, updatedItem)),
    )
    .map((existingItem) => ({
      _id: existingItem._id,
      productId: existingItem.productId,
      productCode: existingItem.productCode,
      productName: existingItem.productName,
      brandName: existingItem.brandName,
      unitPrice: existingItem.unitPrice,
      requestedQuantity: existingItem.requestedQuantity,
      verifiedQuantity: 0,
      isPending: true,
      pendingReason: PENDING_REASON_REMOVED,
      postControl: 'pendiente' as const,
      itemDiscount: existingItem.itemDiscount ?? 0,
      lineTotal: 0,
    }));
}

/** Valida el guard de facturación/entrega para el estado destino. */
function validateStatusGuards(
  nextStatus: OrderStatus,
  items: readonly {
    isPending?: boolean;
    verifiedQuantity?: number;
    requestedQuantity?: number;
    postControl?: PostControl | string | null;
  }[],
): OrderServiceError | null {
  if (nextStatus === 'facturacion' && hasPendingOrderItems(items)) {
    return failure(409, PENDING_ITEMS_BLOCK_ERROR);
  }

  if (nextStatus === 'entregado' && hasUncontrolledPostItems(items)) {
    return failure(409, UNCONTROLLED_POST_ITEMS_BLOCK_ERROR);
  }

  return null;
}

/**
 * Edición integral de un borrador intacto: reemplaza las líneas con precios y
 * descuentos vigentes, ajusta los datos comerciales y mantiene el estado.
 *
 * A diferencia del picking, una línea que no llega en el PUT se descarta (no
 * queda pendiente) porque depósito todavía no trabajó sobre el pedido.
 */
function planDraftOrderEdit(input: PlanOrderUpdateInput): OrderServiceResult<OrderUpdatePlan> {
  const { order, client } = input;

  if (!isDraftOrderIntact(order)) {
    return failure(409, DRAFT_EDIT_BLOCKED_ERROR);
  }

  if (input.status !== undefined && input.status !== 'borrador') {
    return failure(400, 'La edición de un borrador no puede cambiar el estado del pedido.');
  }

  if (input.archived !== undefined) {
    return failure(400, 'La edición de un borrador no puede archivar el pedido.');
  }

  if (input.invoiceType !== undefined && !isInvoiceType(input.invoiceType)) {
    return failure(400, 'Tipo de factura inválido');
  }

  if (input.paymentCondition !== undefined && !isPaymentCondition(input.paymentCondition)) {
    return failure(400, 'Condición de pago inválida');
  }

  if (!input.items || input.items.length === 0) {
    return failure(400, DRAFT_EDIT_INVALID_ITEMS_ERROR);
  }

  const productById = new Map(
    (input.catalogProducts ?? []).map((product) => [String(product._id), product]),
  );
  const discounts = buildClientDiscountResolver(client);

  const items: PlannedOrderItem[] = [];
  let subtotal = 0;
  let totalDiscount = 0;

  for (const incomingItem of input.items) {
    if (incomingItem.productId === undefined) {
      return failure(400, 'Datos inválidos: cada ítem debe incluir un productId');
    }

    const product = productById.get(incomingItem.productId);
    if (!product || product.active === false) {
      return failure(400, DRAFT_EDIT_INACTIVE_PRODUCT_ERROR);
    }

    const requestedQuantity = Number(incomingItem.requestedQuantity) || 0;
    if (requestedQuantity <= 0) continue;

    const unitPrice = product.price;
    const discountPercentage =
      incomingItem.customDiscount !== undefined
        ? discounts.normalize(incomingItem.customDiscount)
        : discounts.resolveForBrand(product.brandId);

    // Misma fórmula que el alta: el borrador se valúa por cantidad pedida.
    const gross = roundCurrency(unitPrice * requestedQuantity);
    const discountAmount = roundCurrency((gross * discountPercentage) / 100);

    subtotal = roundCurrency(subtotal + gross);
    totalDiscount = roundCurrency(totalDiscount + discountAmount);

    items.push({
      productId: product._id,
      ...productSnapshotOf(product),
      unitPrice,
      requestedQuantity,
      verifiedQuantity: 0,
      isPending: false,
      postControl: 'pendiente',
      itemDiscount: discountPercentage,
      lineTotal: roundCurrency(gross - discountAmount),
    });
  }

  if (items.length === 0) {
    return failure(400, DRAFT_EDIT_INVALID_ITEMS_ERROR);
  }

  const plan: OrderUpdatePlan = {
    status: 'borrador',
    notification: null,
    items,
    subtotal,
    totalDiscount,
    finalTotal: roundCurrency(subtotal - totalDiscount),
  };

  // Backfill de pedidos históricos: completa el snapshot sin pisar el original.
  const clientName = order.clientName || client?.name || undefined;
  const clientCode = order.clientCode || client?.code || undefined;
  if (clientName !== undefined) plan.clientName = clientName;
  if (clientCode !== undefined) plan.clientCode = clientCode;

  if (input.invoiceType !== undefined) plan.invoiceType = input.invoiceType;

  if (input.paymentCondition !== undefined) {
    plan.paymentCondition = input.paymentCondition;
    plan.paymentConditionDetail =
      input.paymentCondition === 'otro' ? input.paymentConditionDetail?.trim() || null : null;
  }

  if (input.comment?.trim()) {
    plan.comment = {
      text: input.comment.trim(),
      author: input.author || 'Operario / Sistema',
      role: input.role || 'vendedor',
      createdAt: input.now ?? new Date(),
    };
  }

  return { ok: true, value: plan };
}

/**
 * Calcula el resultado de un PUT sin tocar la base: ítems resueltos, totales,
 * estado destino, comentario y notificación a facturación si corresponde.
 */
export function planOrderUpdate(input: PlanOrderUpdateInput): OrderServiceResult<OrderUpdatePlan> {
  const { order } = input;
  const currentVersion = order.version ?? 0;

  if (input.version !== currentVersion) {
    return orderVersionConflict(currentVersion);
  }

  if (input.draftEdit) {
    return planDraftOrderEdit(input);
  }

  const previousStatus = order.status;
  const client = input.client ?? null;

  // Backfill de pedidos históricos: completa el snapshot del cliente sin
  // pisar el original.
  const clientName = order.clientName || client?.name || undefined;
  const clientCode = order.clientCode || client?.code || undefined;

  const plan: OrderUpdatePlan = {
    status: previousStatus,
    notification: null,
  };

  if (clientName !== undefined) plan.clientName = clientName;
  if (clientCode !== undefined) plan.clientCode = clientCode;
  if (input.archived !== undefined) plan.archived = input.archived;

  let nextStatus: OrderStatus = previousStatus;

  if (input.items) {
    const incomingItems = input.items;

    // Un ítem que no existe en el pedido solo puede ser uno nuevo con productId.
    const hasOrphanItem = incomingItems.some((updatedItem) => {
      const matchesExisting = order.items.some((existingItem) =>
        matchesOrderItem(existingItem, updatedItem),
      );
      return !matchesExisting && updatedItem.productId === undefined;
    });

    if (hasOrphanItem) {
      return failure(400, 'Datos inválidos: cada ítem nuevo debe incluir un productId');
    }

    const productById = new Map(
      (input.catalogProducts ?? []).map((product) => [String(product._id), product]),
    );
    const discounts = buildClientDiscountResolver(client);

    let hasPendingItems = false;

    const resolvedItems: Array<Omit<PlannedOrderItem, 'lineTotal'>> = incomingItems.map(
      (updatedItem) => {
        const existingItem = order.items.find((existing) =>
          matchesOrderItem(existing, updatedItem),
        );
        const catalogProduct =
          updatedItem.productId !== undefined ? productById.get(updatedItem.productId) : undefined;

        const { leavesPending, ...itemValues } = resolveItemValues(
          existingItem,
          updatedItem,
          catalogProduct?.price,
          catalogProduct ? discounts.resolveForBrand(catalogProduct.brandId) : undefined,
        );

        if (leavesPending) hasPendingItems = true;

        // Los ítems existentes conservan su snapshot y su _id (identidad de la
        // línea); los nuevos lo toman del catálogo.
        const snapshot = existingItem
          ? {
              productCode: existingItem.productCode,
              productName: existingItem.productName,
              brandName: existingItem.brandName,
            }
          : productSnapshotOf(catalogProduct);

        return {
          ...(existingItem ? { _id: existingItem._id } : {}),
          productId: existingItem ? existingItem.productId : (updatedItem.productId as unknown),
          ...snapshot,
          ...itemValues,
        };
      },
    );

    // Una línea existente que no llega en el PUT fue quitada desde depósito.
    // No se borra: se conserva como pendiente para no perder la trazabilidad
    // del faltante/backorder (y que facturación lo vea).
    const removedItems = preservedRemovedItems(order.items, incomingItems);
    if (removedItems.length > 0) hasPendingItems = true;

    // Los importes reflejan lo verificado en depósito (misma fórmula que el alta).
    const totals = applyVerifiedTotals([...resolvedItems, ...removedItems]);

    nextStatus = input.status ?? (hasPendingItems ? 'paralizado' : 'facturacion');

    const transitionError = getOrderStatusTransitionError(previousStatus, nextStatus);
    if (transitionError) return failure(400, transitionError);

    const guardError = validateStatusGuards(nextStatus, totals.items);
    if (guardError) return guardError;

    plan.items = totals.items;
    plan.subtotal = totals.subtotal;
    plan.totalDiscount = totals.totalDiscount;
    plan.finalTotal = totals.finalTotal;
  } else if (input.status) {
    nextStatus = input.status;

    const transitionError = getOrderStatusTransitionError(previousStatus, nextStatus);
    if (transitionError) return failure(400, transitionError);

    // Un PUT solo de estado tampoco puede saltear la verificación pendiente.
    const guardError = validateStatusGuards(nextStatus, order.items);
    if (guardError) return guardError;
  }

  plan.status = nextStatus;

  if (input.comment?.trim()) {
    plan.comment = {
      text: input.comment.trim(),
      author: input.author || 'Operario / Sistema',
      role: input.role || nextStatus,
      createdAt: input.now ?? new Date(),
    };
  }

  // Al entrar en facturación se avisa a facturación. Un pedido que ya estaba
  // en `facturacion` y solo se re-guarda no vuelve a notificar.
  const notificationTarget = {
    createdById: order.createdById ? String(order.createdById) : undefined,
    createdBy: order.createdBy,
  };

  if (previousStatus !== 'facturacion' && nextStatus === 'facturacion') {
    plan.notification = buildReadyForBillingNotification({
      clientName: clientName || 'Cliente',
    });
  } else if (previousStatus !== 'paralizado' && nextStatus === 'paralizado') {
    // El vendedor titular recibe el motivo del faltante o el comentario que
    // acompañó al cambio de estado; es una alerta privada, no de depósito.
    const reason =
      plan.comment?.text ||
      plan.items?.find((item) => item.isPending && item.pendingReason?.trim())?.pendingReason ||
      null;

    plan.notification = buildVendorParalyzedNotification({
      ...notificationTarget,
      clientName: clientName || 'Cliente',
      reason,
    });
  } else if (previousStatus !== 'entregado' && nextStatus === 'entregado') {
    plan.notification = buildVendorDeliveredNotification({
      ...notificationTarget,
      clientName: clientName || 'Cliente',
    });
  } else if (
    !plan.notification &&
    plan.comment &&
    (input.role === 'controlador' || input.role === 'billing' || input.role === 'admin')
  ) {
    // Un comentario de depósito, facturación o admin avisa al vendedor titular.
    // Si el mismo PUT ya emitió una alerta (cambio de estado), no se duplica.
    plan.notification = buildVendorOrderCommentNotification({
      ...notificationTarget,
      author: plan.comment.author || input.author || 'Operario / Sistema',
      clientName: clientName || 'Cliente',
      comment: plan.comment.text,
    });
  } else if (
    !plan.notification &&
    plan.comment &&
    input.role === 'vendedor' &&
    previousStatus === nextStatus &&
    (previousStatus === 'borrador' || previousStatus === 'paralizado')
  ) {
    // Un comentario del vendedor en un pedido que sigue en su etapa operativa
    // avisa a depósito. Si el mismo PUT ya generó otra notificación (cambio de
    // estado), no se duplica.
    plan.notification = buildVendorCommentNotification({
      author: plan.comment.author || input.author || 'Vendedor',
      clientName: clientName || 'Cliente',
      comment: plan.comment.text,
    });
  }

  return { ok: true, value: plan };
}

/** Aplica el plan sobre el documento del pedido (adaptador de persistencia). */
export function applyOrderUpdatePlan(
  order: {
    clientName?: string;
    clientCode?: string;
    createdBy?: string;
    shortId?: string;
    searchTokens?: string[];
    archived?: boolean;
    items?: unknown[];
    subtotal?: number;
    totalDiscount?: number;
    finalTotal?: number;
    status: OrderStatus;
    invoiceType?: InvoiceType;
    paymentCondition?: PaymentCondition;
    paymentConditionDetail?: string;
    comments?: OrderCommentInput[];
  },
  plan: OrderUpdatePlan,
): void {
  if (plan.clientName !== undefined) order.clientName = plan.clientName;
  if (plan.clientCode !== undefined) order.clientCode = plan.clientCode;
  if (plan.archived !== undefined) order.archived = plan.archived;

  if (plan.items !== undefined) {
    order.items = plan.items;
    order.subtotal = plan.subtotal;
    order.totalDiscount = plan.totalDiscount;
    order.finalTotal = plan.finalTotal;
  }

  order.status = plan.status;

  if (plan.invoiceType !== undefined) order.invoiceType = plan.invoiceType;
  if (plan.paymentCondition !== undefined) order.paymentCondition = plan.paymentCondition;
  if (plan.paymentConditionDetail !== undefined) {
    order.paymentConditionDetail = plan.paymentConditionDetail ?? undefined;
  }

  if (plan.comment) {
    order.comments = order.comments ?? [];
    order.comments.push(plan.comment);
  }

  // El plan puede cambiar líneas o snapshots del cliente: se recalcula acá
  // además de pre('validate') para que el documento quede consistente incluso
  // en los tests puros que no pasan por save().
  order.searchTokens = buildOrderSearchFields(order).searchTokens;
}

// ---------------------------------------------------------------------------
// Control post-facturación por línea
// ---------------------------------------------------------------------------

export interface PostControlUpdateInput {
  _id: string;
  postControl: PostControl;
}

export interface PostControlPlan {
  assignments: Array<{ itemId: string; postControl: PostControl }>;
}

export interface PlanPostControlInput {
  order: {
    version?: number;
    status: OrderStatus;
    items: readonly unknown[];
  };
  version: number;
  updates: readonly PostControlUpdateInput[];
}

/**
 * Valida versión, estado y existencia de todas las líneas antes de mutar. Si
 * una línea no existe no se guarda parcialmente el control del resto.
 */
export function planPostControlUpdates(
  input: PlanPostControlInput,
): OrderServiceResult<PostControlPlan> {
  const currentVersion = input.order.version ?? 0;
  if (input.version !== currentVersion) {
    return orderVersionConflict(currentVersion);
  }

  if (!POST_CONTROL_STATUSES.includes(input.order.status)) {
    return failure(
      409,
      'El control post-factura solo se registra con el pedido en facturación o control post-factura.',
    );
  }

  const itemIds = new Set(
    input.order.items.map((item) => String((item as { _id?: unknown } | null)?._id)),
  );

  for (const update of input.updates) {
    if (!itemIds.has(update._id)) {
      return failure(404, 'Ítem no encontrado en el pedido');
    }
  }

  return {
    ok: true,
    value: {
      assignments: input.updates.map((update) => ({
        itemId: update._id,
        postControl: update.postControl,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Reexports de reglas puras de totales/pending (API única del dominio)
// ---------------------------------------------------------------------------

export {
  applyVerifiedTotals,
  hasPendingOrderItems,
  matchesOrderItem,
  resolveItemValues,
  PENDING_REASON_REMOVED,
  PENDING_REASON_UNCONTROLLED,
} from '../order-totals';
