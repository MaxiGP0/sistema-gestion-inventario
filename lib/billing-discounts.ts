/**
 * Resumen de descuentos del panel de facturación.
 *
 * Se calcula exclusivamente con los porcentajes congelados en cada línea del
 * pedido (`itemDiscount`), que ya incluyen el descuento de marca o el ajuste
 * manual aplicado al crearlo. Nunca lee `generalDiscount`/`brandDiscounts`
 * actuales del cliente: si su ficha cambia después del alta, el análisis sigue
 * mostrando lo que realmente se aplicó.
 */

import { roundCurrency } from './money';

export interface BillingDiscountItemLike {
  /** Snapshot de la marca al momento del pedido. */
  brandName?: string | null;
  productId?: {
    brandId?: {
      _id?: unknown;
      name?: string | null;
    } | null;
  } | null;
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity?: number | null;
  /** Porcentaje congelado de la línea (marca, general o ajuste manual). */
  itemDiscount?: number | null;
}

/**
 * Cantidad con la que se ponderan los importes:
 * - `verified` (facturación): lo controlado en depósito, con fallback a lo pedido.
 * - `requested` (hoja de control): siempre lo solicitado, aunque falte stock.
 */
export type BillingQuantityMode = 'verified' | 'requested';

export interface BillingBrandDiscountSummary {
  brandId?: string;
  brandName: string;
  /** Líneas con importe bruto mayor que 0 para el modo de cantidad elegido. */
  lineCount: number;
  /** Porcentaje más bajo aplicado a las líneas de la marca. */
  minDiscountPercentage: number;
  /** Porcentaje más alto aplicado a las líneas de la marca. */
  maxDiscountPercentage: number;
  /** Porcentaje efectivo ponderado por el bruto de las líneas. */
  discountPercentage: number;
  subtotal: number;
  discountAmount: number;
}

export interface BillingDiscountSummary {
  /** Líneas con importe bruto mayor que 0 para el modo de cantidad elegido. */
  lineCount: number;
  subtotal: number;
  totalDiscount: number;
  /** Descuento efectivo sobre el subtotal (0-100). */
  effectiveDiscountPercentage: number;
  minLineDiscountPercentage: number;
  maxLineDiscountPercentage: number;
  brands: BillingBrandDiscountSummary[];
}

interface BrandAccumulator {
  brandId?: string;
  brandName: string;
  lineCount: number;
  minDiscountPercentage: number;
  maxDiscountPercentage: number;
  subtotal: number;
  discountAmount: number;
}

const normalizePercentage = (value: unknown): number => {
  const percentage = Number(value);
  return Number.isFinite(percentage) ? percentage : 0;
};

const quantityOf = (item: BillingDiscountItemLike, quantityMode: BillingQuantityMode): number => {
  const quantity =
    quantityMode === 'requested'
      ? item.requestedQuantity
      : item.verifiedQuantity !== undefined && item.verifiedQuantity !== null
        ? item.verifiedQuantity
        : item.requestedQuantity;

  return Number.isFinite(Number(quantity)) ? Number(quantity) : 0;
};

const brandNameOf = (item: BillingDiscountItemLike): string => {
  const snapshot = item.brandName?.trim();
  if (snapshot) return snapshot;

  const populated = item.productId?.brandId?.name?.trim();
  return populated || 'Sin marca';
};

const brandIdOf = (item: BillingDiscountItemLike): string | undefined => {
  const brandId = item.productId?.brandId?._id;
  return brandId === undefined || brandId === null ? undefined : String(brandId);
};

const brandKeyOf = (item: BillingDiscountItemLike, brandName: string): string => {
  const brandId = brandIdOf(item);
  return brandId ? `id:${brandId}` : `name:${brandName.toLocaleLowerCase('es')}`;
};

/**
 * Agrupa las líneas por marca y calcula los importes usando el mismo criterio
 * de redondeo que los totales del pedido (lib/order-totals.ts).
 *
 * Por defecto usa las cantidades verificadas para no alterar los importes de
 * facturación. La hoja de control de pedido pasa `'requested'` para totalizar
 * sobre lo solicitado, incluidas las líneas pendientes o faltantes.
 */
export function summarizeBillingDiscounts(
  items: readonly BillingDiscountItemLike[],
  quantityMode: BillingQuantityMode = 'verified',
): BillingDiscountSummary {
  const brands = new Map<string, BrandAccumulator>();

  let lineCount = 0;
  let subtotal = 0;
  let totalDiscount = 0;
  let minLineDiscountPercentage = Number.POSITIVE_INFINITY;
  let maxLineDiscountPercentage = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const quantity = quantityOf(item, quantityMode);
    const gross = roundCurrency((Number(item.unitPrice) || 0) * quantity);

    // Las líneas sin controlar (cantidad 0) no se facturan ni aportan descuento.
    if (gross <= 0) continue;

    const percentage = normalizePercentage(item.itemDiscount);
    const discountAmount = roundCurrency((gross * percentage) / 100);

    lineCount += 1;
    subtotal = roundCurrency(subtotal + gross);
    totalDiscount = roundCurrency(totalDiscount + discountAmount);
    minLineDiscountPercentage = Math.min(minLineDiscountPercentage, percentage);
    maxLineDiscountPercentage = Math.max(maxLineDiscountPercentage, percentage);

    const brandName = brandNameOf(item);
    const brandKey = brandKeyOf(item, brandName);
    const brand = brands.get(brandKey);

    if (brand) {
      brand.lineCount += 1;
      brand.minDiscountPercentage = Math.min(brand.minDiscountPercentage, percentage);
      brand.maxDiscountPercentage = Math.max(brand.maxDiscountPercentage, percentage);
      brand.subtotal = roundCurrency(brand.subtotal + gross);
      brand.discountAmount = roundCurrency(brand.discountAmount + discountAmount);
    } else {
      brands.set(brandKey, {
        brandId: brandIdOf(item),
        brandName,
        lineCount: 1,
        minDiscountPercentage: percentage,
        maxDiscountPercentage: percentage,
        subtotal: gross,
        discountAmount,
      });
    }
  }

  const brandSummaries = Array.from(brands.values())
    .map((brand) => ({
      brandId: brand.brandId,
      brandName: brand.brandName,
      lineCount: brand.lineCount,
      minDiscountPercentage: brand.minDiscountPercentage,
      maxDiscountPercentage: brand.maxDiscountPercentage,
      discountPercentage: brand.subtotal > 0 ? (brand.discountAmount / brand.subtotal) * 100 : 0,
      subtotal: brand.subtotal,
      discountAmount: brand.discountAmount,
    }))
    .sort((a, b) => a.brandName.localeCompare(b.brandName, 'es'));

  return {
    lineCount,
    subtotal,
    totalDiscount,
    effectiveDiscountPercentage: subtotal > 0 ? (totalDiscount / subtotal) * 100 : 0,
    minLineDiscountPercentage: lineCount > 0 ? minLineDiscountPercentage : 0,
    maxLineDiscountPercentage: lineCount > 0 ? maxLineDiscountPercentage : 0,
    brands: brandSummaries,
  };
}

/** Formatea un porcentaje sin decimales innecesarios (25, 7.5, 0). */
export function formatDiscountPercentage(value: number): string {
  return Number(value.toFixed(2)).toLocaleString('es-AR');
}

/** Rango de porcentajes aplicados; un solo valor si todas las líneas coinciden. */
export function formatDiscountRange(
  summary: Pick<
    BillingDiscountSummary,
    'lineCount' | 'minLineDiscountPercentage' | 'maxLineDiscountPercentage'
  >,
): string {
  if (summary.lineCount === 0) return '—';

  const min = formatDiscountPercentage(summary.minLineDiscountPercentage);
  const max = formatDiscountPercentage(summary.maxLineDiscountPercentage);

  return min === max ? `${min}%` : `${min}% – ${max}%`;
}

/** Porcentaje aplicado a una marca; rango si sus líneas tienen ajustes distintos. */
export function formatBrandDiscount(
  brand: Pick<BillingBrandDiscountSummary, 'minDiscountPercentage' | 'maxDiscountPercentage'>,
): string {
  const min = formatDiscountPercentage(brand.minDiscountPercentage);
  const max = formatDiscountPercentage(brand.maxDiscountPercentage);

  return min === max ? `${min}%` : `${min}% – ${max}%`;
}
