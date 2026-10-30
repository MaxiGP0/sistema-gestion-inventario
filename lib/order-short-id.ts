/**
 * Código corto visible de un pedido.
 *
 * El identificador completo de Mongo tiene 24 caracteres hexadecimales. Para
 * mostrarlo y buscarlo en la bandeja se usan los últimos 6, en minúsculas, que
 * es el mismo valor que el schema persiste en `Order.shortId`.
 */

export const ORDER_SHORT_ID_LENGTH = 6;

/** Últimos 6 caracteres del id, siempre en minúsculas. */
export function orderShortId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .slice(-ORDER_SHORT_ID_LENGTH);
}

/** Código corto listo para mostrar: `#a1b2c3`. */
export function formatOrderShortId(value: unknown): string {
  return `#${orderShortId(value)}`;
}
