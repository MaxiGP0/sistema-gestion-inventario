/**
 * Cálculo de precios del catálogo, compartido por la UI y la API.
 *
 * El IVA del catálogo es fijo (21%). Todos los importes que se persisten o se
 * muestran se redondean a 2 decimales para que el ajuste masivo no acumule
 * diferencias de punto flotante (por ejemplo, 1000 * 1.1 = 1100.0000000000002).
 */

/** Alícuota de IVA aplicada a los precios del catálogo. */
export const IVA_RATE = 1.21;

/** Límites del ajuste porcentual masivo (permite llevar un precio a 0). */
export const MIN_PRICE_ADJUSTMENT_PERCENTAGE = -100;
export const MAX_PRICE_ADJUSTMENT_PERCENTAGE = 1000;

/** Precio de catálogo con IVA, redondeado a 2 decimales. */
export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Dado un precio sin IVA, devuelve el precio con IVA redondeado. */
export function priceWithIvaFromNet(price: number): number {
  return roundCurrency(price * IVA_RATE);
}

/** Dado un precio con IVA, devuelve el precio sin IVA redondeado. */
export function netPriceFromGross(priceWithIva: number): number {
  return roundCurrency(priceWithIva / IVA_RATE);
}

export interface PricedProduct {
  price: number;
  priceWithIva?: number;
}

/**
 * Aplica un porcentaje (positivo o negativo) a ambos precios del producto.
 * Cada importe se ajusta de forma independiente y se redondea a 2 decimales.
 */
export function calculateAdjustedPrices(
  product: PricedProduct,
  percentage: number,
): { price: number; priceWithIva: number } {
  const factor = 1 + percentage / 100;
  const net = Number(product.price) || 0;
  const gross =
    typeof product.priceWithIva === 'number' && Number.isFinite(product.priceWithIva)
      ? product.priceWithIva
      : net * IVA_RATE;

  return {
    price: roundCurrency(net * factor),
    priceWithIva: roundCurrency(gross * factor),
  };
}

/**
 * Parsea el porcentaje que escribe el usuario ("+10%", "-5", "7,5%").
 * Devuelve `null` si no es un número válido o está fuera del rango permitido.
 */
export function parseAdjustmentPercentage(input: string | number): number | null {
  const value =
    typeof input === 'number' ? input : Number(input.trim().replace(/%$/, '').replace(',', '.'));

  if (!Number.isFinite(value) || value === 0) return null;
  if (value < MIN_PRICE_ADJUSTMENT_PERCENTAGE || value > MAX_PRICE_ADJUSTMENT_PERCENTAGE) {
    return null;
  }

  return value;
}

/** Etiqueta legible del ajuste (ej. `+10%` o `-5%`). */
export function formatAdjustmentPercentage(value: number): string {
  return `${value > 0 ? '+' : ''}${value}%`;
}
