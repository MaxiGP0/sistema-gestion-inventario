/**
 * Redondeo monetario centralizado.
 *
 * Los importes del sistema son pesos/dólares con 2 decimales; las operaciones
 * en punto flotante (precio x cantidad, porcentajes) introducen colas binarias
 * (p. ej. 4.905 -> 4.904999999...). `roundCurrency` redondea a 2 decimales con
 * medio hacia arriba de forma estable en todo el rango razonable de precios.
 */

/**
 * Corrección mínima (1e-9 sobre la escala de centavos) para que los valores que
 * quedan un pelo por debajo del medio centavo por error binario se redondeen
 * hacia arriba, como los espera ver el usuario (4.905 -> 4.91).
 */
const CENT_BIAS = 1e-9;

/** Redondea un importe a 2 decimales; valores no finitos caen a 0. */
export function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * 100;
  const biased = scaled >= 0 ? scaled + CENT_BIAS : scaled - CENT_BIAS;
  return Math.round(biased) / 100;
}
