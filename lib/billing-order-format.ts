/**
 * Formato compartido entre el panel de facturación y el texto que se copia.
 *
 * Las líneas nunca se filtran por `lineTotal === 0`: una línea en cero es un
 * faltante/sin controlar y debe quedar visible para quien factura.
 */

export const MISSING_LINE_LABEL = 'Sin controlar/faltante';

export interface BillingOrderItemLike {
  productCode?: string;
  productName?: string;
  brandName?: string;
  productId?: {
    code: string;
    name: string;
    brandId?: { name: string } | null;
  } | null;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity?: number | null;
  itemDiscount?: number;
  lineTotal: number;
  pendingReason?: string;
}

/** Cantidad efectivamente controlada; cae a la pedida si no hay verificación. */
export function billingLineQuantity(item: BillingOrderItemLike): number {
  return item.verifiedQuantity !== undefined && item.verifiedQuantity !== null
    ? item.verifiedQuantity
    : item.requestedQuantity;
}

/** Motivo guardado por depósito o un texto por defecto para las líneas en 0. */
export function billingPendingDetail(item: BillingOrderItemLike): string {
  return item.pendingReason?.trim() || (item.lineTotal === 0 ? 'No verificado en depósito' : '');
}

/** Línea del texto estructurado, con la marca de faltante cuando corresponde. */
export function formatBillingItemLine(item: BillingOrderItemLike, index: number): string {
  const qty = billingLineQuantity(item);
  const pendingDetail = billingPendingDetail(item);

  let line =
    `${index + 1}. [${item.productCode ?? item.productId?.code}] ` +
    `${item.productName ?? item.productId?.name} ` +
    `(${item.brandName ?? item.productId?.brandId?.name ?? 'N/A'}) | ` +
    `Cant: ${qty} | Precio Unit: $${item.unitPrice} | ` +
    `Desc: ${item.itemDiscount}% | Total: $${item.lineTotal.toFixed(2)}`;

  if (item.lineTotal === 0) {
    line += ` | ${MISSING_LINE_LABEL}: ${pendingDetail}`;
  } else if (pendingDetail) {
    line += ` | Motivo pendiente: ${pendingDetail}`;
  }

  return line;
}
