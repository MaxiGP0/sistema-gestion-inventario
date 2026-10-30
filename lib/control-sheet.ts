/**
 * Hoja de control de pedido (impresión para depósito) y comprobante verificado
 * (impresión para facturación).
 *
 * Agrupa todas las líneas por marca, incluidas las pendientes o faltantes, y
 * resume los importes con el descuento congelado de cada línea (`itemDiscount`).
 * El modo `'requested'` totaliza sobre lo pedido para preparar mercadería; el
 * modo `'verified'` usa lo controlado en depósito para reflejar el importe real
 * a facturar y el motivo de cada faltante.
 */

import { summarizeBillingDiscounts } from './billing-discounts';
import { roundCurrency } from './money';

/** Etapa de la hoja: preparación solicitada o comprobante verificado. */
export type ControlSheetMode = 'requested' | 'verified';

/** Línea mínima necesaria para armar la hoja (el DTO del pedido la cumple). */
export interface ControlSheetItemLike {
  productCode?: string | null;
  productName?: string | null;
  brandName?: string | null;
  productId?: {
    code?: string | null;
    name?: string | null;
    brandId?: {
      _id?: unknown;
      name?: string | null;
    } | null;
  } | null;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity?: number | null;
  isPending?: boolean | null;
  pendingReason?: string | null;
  /** Porcentaje congelado de la línea (marca, general o ajuste manual). */
  itemDiscount?: number | null;
}

export interface ControlSheetLineStatus {
  /** Cantidad controlada; cae a la pedida en pedidos históricos sin verificar. */
  quantity: number;
  isShort: boolean;
  /** Motivo de depósito o un faltante calculado con las cantidades. */
  label: string;
}

export interface ControlSheetBrandGroup<T extends ControlSheetItemLike> {
  brandName: string;
  /** Líneas de la marca, todas incluidas y ordenadas por código natural. */
  items: T[];
  lineCount: number;
  /** Porcentaje más bajo aplicado a las líneas de la marca. */
  minDiscountPercentage: number;
  /** Porcentaje más alto aplicado a las líneas de la marca. */
  maxDiscountPercentage: number;
  /** Bruto según la cantidad del modo activo (solicitada o verificada). */
  subtotal: number;
  /** Descuento según la cantidad del modo activo. */
  discountAmount: number;
}

export interface ControlSheetTotals {
  lineCount: number;
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  /** Descuento efectivo sobre el subtotal (0-100). */
  effectiveDiscountPercentage: number;
  minLineDiscountPercentage: number;
  maxLineDiscountPercentage: number;
}

/** Código visible de la línea, con fallback al producto poblado. */
export function controlSheetItemCode(item: ControlSheetItemLike): string {
  return item.productCode?.trim() || item.productId?.code?.trim() || '';
}

/** Descripción visible de la línea, con fallback al producto poblado. */
export function controlSheetItemName(item: ControlSheetItemLike): string {
  return item.productName?.trim() || item.productId?.name?.trim() || '';
}

/** Nombre de marca con el mismo criterio de fallback de toda la app. */
export function controlSheetBrandName(item: ControlSheetItemLike): string {
  return item.brandName?.trim() || item.productId?.brandId?.name?.trim() || 'Sin marca';
}

/** Orden natural de códigos: P-2 antes que P-10. */
export function compareNaturalCodes(a: string, b: string): number {
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

const requestedQuantityOf = (item: ControlSheetItemLike): number => {
  const quantity = Number(item.requestedQuantity);
  return Number.isFinite(quantity) ? quantity : 0;
};

/** Cantidad verificada; si el pedido histórico no la trae, usa la pedida. */
export const verifiedQuantityOf = (item: ControlSheetItemLike): number => {
  if (item.verifiedQuantity !== undefined && item.verifiedQuantity !== null) {
    const quantity = Number(item.verifiedQuantity);
    if (Number.isFinite(quantity)) return quantity;
  }

  return requestedQuantityOf(item);
};

const quantityOf = (item: ControlSheetItemLike, mode: ControlSheetMode): number =>
  mode === 'requested' ? requestedQuantityOf(item) : verifiedQuantityOf(item);

const discountPercentageOf = (item: ControlSheetItemLike): number => {
  const percentage = Number(item.itemDiscount);
  return Number.isFinite(percentage) ? percentage : 0;
};

/**
 * Estado de la línea para la última columna del comprobante verificado.
 * Una línea está en faltante si depósito la marcó pendiente o controló menos
 * de lo pedido. El motivo guardado manda; si no hay, se informan las cantidades.
 */
export function controlSheetLineStatus(item: ControlSheetItemLike): ControlSheetLineStatus {
  const requested = requestedQuantityOf(item);
  const quantity = verifiedQuantityOf(item);
  const isShort = Boolean(item.isPending) || quantity < requested;

  if (!isShort) {
    return { quantity, isShort: false, label: 'Completo' };
  }

  const reason = item.pendingReason?.trim();
  return {
    quantity,
    isShort: true,
    label: reason || (quantity < requested ? `Faltante: ${quantity} de ${requested}` : 'Pendiente'),
  };
}

/**
 * Agrupa todas las líneas por marca, ordena las marcas alfabéticamente y los
 * productos por código natural. Las líneas pendientes, con cantidad 0 o con
 * producto eliminado también forman parte del resultado. Los importes del
 * grupo se calculan con la cantidad del modo elegido.
 */
export function groupOrderItemsByBrand<T extends ControlSheetItemLike>(
  items: readonly T[],
  mode: ControlSheetMode = 'requested',
): ControlSheetBrandGroup<T>[] {
  const groups = new Map<string, { brandName: string; items: T[] }>();

  for (const item of items) {
    const brandName = controlSheetBrandName(item);
    const key = brandName.toLocaleLowerCase('es');
    const group = groups.get(key);

    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, { brandName, items: [item] });
    }
  }

  return Array.from(groups.values())
    .map(({ brandName, items: brandItems }) => {
      let subtotal = 0;
      let discountAmount = 0;
      let minDiscountPercentage = Number.POSITIVE_INFINITY;
      let maxDiscountPercentage = Number.NEGATIVE_INFINITY;

      for (const item of brandItems) {
        const quantity = quantityOf(item, mode);
        const percentage = discountPercentageOf(item);
        const gross = roundCurrency((Number(item.unitPrice) || 0) * quantity);

        subtotal = roundCurrency(subtotal + gross);
        discountAmount = roundCurrency(discountAmount + roundCurrency((gross * percentage) / 100));
        minDiscountPercentage = Math.min(minDiscountPercentage, percentage);
        maxDiscountPercentage = Math.max(maxDiscountPercentage, percentage);
      }

      return {
        brandName,
        items: [...brandItems].sort((a, b) =>
          compareNaturalCodes(controlSheetItemCode(a), controlSheetItemCode(b)),
        ),
        lineCount: brandItems.length,
        minDiscountPercentage,
        maxDiscountPercentage,
        subtotal,
        discountAmount,
      };
    })
    .sort((a, b) =>
      a.brandName.localeCompare(b.brandName, 'es', { numeric: true, sensitivity: 'base' }),
    );
}

/**
 * Totales de la hoja con los porcentajes congelados de cada línea.
 * `requested` usa lo pedido; `verified` usa lo controlado en depósito, por lo
 * que coincide con el total real a facturar. `finalTotal = subtotal - totalDiscount`.
 */
export function summarizeControlSheetTotals(
  items: readonly ControlSheetItemLike[],
  mode: ControlSheetMode = 'requested',
): ControlSheetTotals {
  const summary = summarizeBillingDiscounts(items, mode);

  return {
    lineCount: summary.lineCount,
    subtotal: summary.subtotal,
    totalDiscount: summary.totalDiscount,
    finalTotal: roundCurrency(summary.subtotal - summary.totalDiscount),
    effectiveDiscountPercentage: summary.effectiveDiscountPercentage,
    minLineDiscountPercentage: summary.minLineDiscountPercentage,
    maxLineDiscountPercentage: summary.maxLineDiscountPercentage,
  };
}
