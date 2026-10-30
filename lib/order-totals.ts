/**
 * Regla de totales post-picking (PUT /api/orders/[id]).
 *
 * Los importes del pedido reflejan lo verificado en depósito y usan la misma
 * fórmula que el alta (POST /api/orders):
 *
 *   bruto     = unitPrice x verifiedQuantity
 *   descuento = bruto x itemDiscount / 100   (itemDiscount es un porcentaje)
 *   lineTotal = bruto - descuento
 *
 * subtotal = suma de brutos; totalDiscount = suma de descuentos;
 * finalTotal = subtotal - totalDiscount.
 *
 * Todos los importes se redondean a 2 decimales con lib/money.ts para que
 * subtotal - totalDiscount = finalTotal = suma de lineTotal, sin centavos
 * fantasma por punto flotante.
 *
 * Los ítems sin verificar (verifiedQuantity 0, p. ej. pendientes/paralizados)
 * aportan 0: no se factura lo que no se controló.
 */

import { roundCurrency } from './money';
import type { PostControl } from './order-post-control';

/** Motivos que genera depósito cuando no puede facturar una línea completa. */
export const PENDING_REASON_UNCONTROLLED = 'Sin controlar en depósito';
export const PENDING_REASON_REMOVED = 'Eliminado en depósito';

/** Ítem ya persistido en el pedido (mongoose subdocument o proyección de tests). */
export interface ExistingOrderItemLike {
  _id?: unknown;
  productId: unknown;
  unitPrice: number;
  requestedQuantity: number;
  itemDiscount?: number;
  isPending?: boolean;
  pendingReason?: string;
  postControl?: PostControl;
}

/** Ítem tal como llega en el body del PUT. */
export interface IncomingOrderItemLike {
  _id?: string;
  productId?: string;
  verifiedQuantity?: number;
  requestedQuantity?: number;
  isPending?: boolean;
  pendingReason?: string;
  customDiscount?: number;
}

export interface ResolvedItemValues {
  unitPrice: number;
  requestedQuantity: number;
  itemDiscount: number;
  verifiedQuantity: number;
  isPending: boolean;
  /** Motivo/estado de la línea; solo se guarda mientras la línea siga pendiente. */
  pendingReason?: string;
  /** Control post-facturación ya registrado (los ítems nuevos arrancan pendientes). */
  postControl: PostControl;
  /** true si el ítem queda pendiente o se verificó por debajo de lo pedido. */
  leavesPending: boolean;
}

const idOf = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

/** Interfaz mínima para evaluar si una línea quedó pendiente de verificación. */
export interface PendingEvaluableItem {
  isPending?: boolean;
  verifiedQuantity?: number;
  requestedQuantity?: number;
}

/** Una línea está pendiente si se marcó así o no se verificó la cantidad pedida. */
export function isItemPending(item: PendingEvaluableItem): boolean {
  return Boolean(item.isPending) || (item.verifiedQuantity ?? 0) < (item.requestedQuantity ?? 0);
}

/** El pedido no puede facturarse mientras tenga al menos una línea pendiente. */
export function hasPendingOrderItems(items: readonly PendingEvaluableItem[]): boolean {
  return items.some((item) => isItemPending(item));
}

/** Un ítem entrante matchea a uno existente por _id o por productId. */
export function matchesOrderItem(
  existing: ExistingOrderItemLike,
  updated: IncomingOrderItemLike,
): boolean {
  const existingId = idOf(existing._id);
  const existingProductId = idOf(existing.productId);

  return (
    (updated._id !== undefined && existingId === updated._id) ||
    (updated.productId !== undefined && existingProductId === updated.productId)
  );
}

/**
 * Motivo por defecto cuando depósito deja la línea pendiente. Si la marcó
 * explícitamente se usa el genérico; si controló menos de lo pedido, se deja
 * asentado el faltante con las cantidades.
 */
function defaultPendingReason(
  isPending: boolean,
  verifiedQuantity: number,
  requestedQuantity: number,
): string {
  if (isPending) return PENDING_REASON_UNCONTROLLED;
  return `Faltante: ${verifiedQuantity} de ${requestedQuantity} controlados`;
}

/**
 * Resuelve los valores persistibles de una línea del picking.
 * Los ítems existentes conservan precio/descuento/cantidad pedida del alta.
 * Los ítems nuevos (agregados desde depósito) usan el precio del catálogo y,
 * si no traen un descuento propio, el descuento del cliente para la marca (o
 * el general). Su cantidad pedida es la que envía depósito y, si no viene,
 * lo verificado (no queda en 0 como antes).
 */
export function resolveItemValues(
  existing: ExistingOrderItemLike | undefined,
  updated: IncomingOrderItemLike,
  catalogUnitPrice?: number,
  catalogDiscountPercentage?: number,
): ResolvedItemValues {
  const verifiedQuantity = updated.verifiedQuantity ?? 0;
  const isPending = updated.isPending ?? false;
  const requestedQuantity = existing
    ? existing.requestedQuantity
    : (updated.requestedQuantity ?? verifiedQuantity);
  const leavesPending = isItemPending({ isPending, verifiedQuantity, requestedQuantity });

  // El motivo es estado de la línea: se limpia al volver a controlarla y, si
  // depósito no escribió uno, se conserva el anterior o se genera uno claro.
  const pendingReason = leavesPending
    ? updated.pendingReason?.trim() ||
      existing?.pendingReason?.trim() ||
      defaultPendingReason(isPending, verifiedQuantity, requestedQuantity)
    : undefined;

  return {
    unitPrice: existing ? existing.unitPrice : (catalogUnitPrice ?? 0),
    requestedQuantity,
    itemDiscount: existing
      ? (existing.itemDiscount ?? 0)
      : (updated.customDiscount ?? catalogDiscountPercentage ?? 0),
    verifiedQuantity,
    isPending,
    pendingReason,
    // El control post-factura es independiente del picking y se conserva al
    // volver a guardar cantidades verificadas.
    postControl: existing?.postControl ?? 'pendiente',
    leavesPending,
  };
}

export interface LineForTotals {
  unitPrice: number;
  verifiedQuantity: number;
  /** Porcentaje 0-100 aplicado a la línea. */
  itemDiscount: number;
}

/**
 * Recalcula lineTotal de cada línea y los totales del pedido a partir de las
 * cantidades verificadas.
 */
export function applyVerifiedTotals<T extends LineForTotals>(
  lines: T[],
): {
  items: Array<T & { lineTotal: number }>;
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
} {
  let subtotal = 0;
  let totalDiscount = 0;

  const items = lines.map((line) => {
    const gross = roundCurrency(line.unitPrice * line.verifiedQuantity);
    const discountAmount = roundCurrency((gross * line.itemDiscount) / 100);
    subtotal = roundCurrency(subtotal + gross);
    totalDiscount = roundCurrency(totalDiscount + discountAmount);

    return { ...line, lineTotal: roundCurrency(gross - discountAmount) };
  });

  return { items, subtotal, totalDiscount, finalTotal: roundCurrency(subtotal - totalDiscount) };
}
