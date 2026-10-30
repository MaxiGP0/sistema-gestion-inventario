/**
 * Estado visible de una línea del pedido para el vendedor.
 *
 * El detalle de "Mis pedidos" antes sólo distinguía entre "Pendiente" y
 * "—". Eso marcaba como pendiente un borrador que depósito todavía no tocó y
 * ocultaba los faltantes parciales (`verifiedQuantity` menor a la pedida pero
 * mayor a cero). Este módulo concentra la regla para poder probarla sin React.
 *
 * Módulo puro (sin React ni Next) para poder probarlo con `node:test`.
 */

import type { OrderStatus } from './order-statuses';
import type { OrderItemDTO } from './types';

export type OrderLineStatusKind = 'unverified' | 'missing' | 'partial' | 'controlled';

export type OrderLineStatusTone = 'neutral' | 'danger' | 'warning' | 'success';

export interface OrderLineStatus {
  kind: OrderLineStatusKind;
  tone: OrderLineStatusTone;
  label: string;
}

export type OrderLineStatusItem = Pick<
  OrderItemDTO,
  'requestedQuantity' | 'verifiedQuantity' | 'isPending' | 'pendingReason'
>;

/**
 * Un borrador intacto es una línea que depósito todavía no controló: no tiene
 * cantidad verificada, no está marcada como pendiente y no registra motivo.
 * En ese caso no hay que alarmar al vendedor con un "Pendiente".
 */
export function isUnverifiedDraftLine(
  item: OrderLineStatusItem,
  orderStatus: OrderStatus,
): boolean {
  return (
    orderStatus === 'borrador' &&
    item.verifiedQuantity === 0 &&
    !item.isPending &&
    !item.pendingReason?.trim()
  );
}

/** Clasifica la línea en uno de los cuatro estados que muestra el detalle. */
export function getOrderLineStatus(
  item: OrderLineStatusItem,
  orderStatus: OrderStatus,
): OrderLineStatus {
  if (isUnverifiedDraftLine(item, orderStatus)) {
    return { kind: 'unverified', tone: 'neutral', label: 'Sin verificar aún' };
  }

  // `isPending` gana incluso si depósito dejó una cantidad parcial: la línea
  // sigue retenida y su motivo debe quedar visible.
  if (item.isPending || item.verifiedQuantity === 0) {
    return { kind: 'missing', tone: 'danger', label: 'Sin stock / Pendiente' };
  }

  if (item.verifiedQuantity < item.requestedQuantity) {
    return {
      kind: 'partial',
      tone: 'warning',
      label: `Faltante parcial (${item.verifiedQuantity} de ${item.requestedQuantity})`,
    };
  }

  return {
    kind: 'controlled',
    tone: 'success',
    label: `Controlado (${item.verifiedQuantity})`,
  };
}

/** ¿La línea representa un faltante total o parcial que debe resumirse? */
export function orderLineHasShortage(item: OrderLineStatusItem, orderStatus: OrderStatus): boolean {
  const { kind } = getOrderLineStatus(item, orderStatus);
  return kind === 'missing' || kind === 'partial';
}

/** Cantidad de líneas con faltante total o parcial (excluye borrador intacto). */
export function countOrderLineShortages(
  items: readonly OrderLineStatusItem[],
  orderStatus: OrderStatus,
): number {
  return items.filter((item) => orderLineHasShortage(item, orderStatus)).length;
}
