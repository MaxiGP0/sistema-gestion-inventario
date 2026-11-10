/**
 * Formato compartido entre el panel de facturación y el texto que se copia.
 *
 * Las líneas nunca se filtran por importe: una línea sin cantidad controlada
 * es un faltante/sin controlar y debe quedar visible para quien factura. En
 * cambio, una línea controlada con 100% de descuento sigue siendo válida
 * aunque su `lineTotal` sea 0.
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

/**
 * ¿La línea quedó sin cantidad controlada? El total en 0 no alcanza para
 * decidirlo porque un descuento del 100% también deja la línea en cero.
 */
export function isMissingLine(item: BillingOrderItemLike): boolean {
  return billingLineQuantity(item) <= 0;
}

/** Motivo guardado por depósito o un texto por defecto para las líneas faltantes. */
export function billingPendingDetail(item: BillingOrderItemLike): string {
  return item.pendingReason?.trim() || (isMissingLine(item) ? 'No verificado en depósito' : '');
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

  if (isMissingLine(item)) {
    line += ` | ${MISSING_LINE_LABEL}: ${pendingDetail}`;
  } else if (pendingDetail) {
    line += ` | Motivo pendiente: ${pendingDetail}`;
  }

  return line;
}
