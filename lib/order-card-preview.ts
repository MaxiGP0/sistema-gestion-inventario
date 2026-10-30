/**
 * Contexto compacto de las tarjetas de la bandeja.
 *
 * El listado liviano trae snapshots de las líneas y el último comentario, pero
 * no el pedido completo. Estas funciones puras resumen ese payload para que la
 * tarjeta muestre productos, faltantes y la última observación sin abrir el
 * detalle ni poblar productos.
 */

import type { OrderSummaryDTO, OrderSummaryItemDTO } from './types';

/** Cantidad de productos que entran en el adelanto de la tarjeta. */
export const ORDER_CARD_PRODUCT_PREVIEW_LIMIT = 2;

export interface OrderCardPendingSummary {
  /** Líneas con faltante; 0 cuando la alerta es sólo por el estado paralizado. */
  count: number;
  /** Primer motivo registrado por depósito, si existe. */
  reason: string | null;
}

function orderItemQuantity(item: OrderSummaryItemDTO): number {
  return item.requestedQuantity ?? item.verifiedQuantity ?? 0;
}

function orderItemLabel(item: OrderSummaryItemDTO): string {
  return item.productName?.trim() || item.productCode?.trim() || 'Producto';
}

function orderItemHasPendingReason(item: OrderSummaryItemDTO): boolean {
  return Boolean(item.pendingReason?.trim());
}

/**
 * Adelanto de hasta `limit` productos: `"3x Shampoo · 2x Acondicionador (+4 más)"`.
 * La tarjeta se encarga de recortarlo visualmente a dos líneas.
 */
export function buildOrderProductPreview(
  order: Pick<OrderSummaryDTO, 'items'>,
  limit = ORDER_CARD_PRODUCT_PREVIEW_LIMIT,
): string {
  const items = order.items ?? [];
  if (items.length === 0) return '';

  const visible = items.slice(0, Math.max(1, limit));
  const parts = visible.map((item) => `${orderItemQuantity(item)}x ${orderItemLabel(item)}`);
  const remaining = items.length - visible.length;

  return remaining > 0 ? `${parts.join(' · ')} (+${remaining} más)` : parts.join(' · ');
}

/**
 * Resumen de faltantes para la alerta de la tarjeta. Devuelve `null` cuando el
 * pedido no está paralizado ni tiene líneas marcadas como pendientes.
 */
export function getOrderPendingSummary(
  order: Pick<OrderSummaryDTO, 'status' | 'items'>,
): OrderCardPendingSummary | null {
  const items = order.items ?? [];
  const flagged = items.filter((item) => item.isPending || orderItemHasPendingReason(item));
  const isParalized = order.status === 'paralizado';

  if (!isParalized && flagged.length === 0) return null;

  const shortfall = items.filter(
    (item) =>
      item.isPending ||
      orderItemHasPendingReason(item) ||
      (item.verifiedQuantity ?? 0) < (item.requestedQuantity ?? 0),
  );
  const count = isParalized ? shortfall.length : flagged.length;
  const reason = flagged.find(orderItemHasPendingReason)?.pendingReason?.trim() ?? null;

  return { count, reason };
}

/** Texto del último comentario no vacío, ya recortado por la tarjeta. */
export function getOrderLastComment(order: Pick<OrderSummaryDTO, 'comments'>): string | null {
  const comments = order.comments ?? [];

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const text = comments[index]?.text?.trim();
    if (text) return text;
  }

  return null;
}
