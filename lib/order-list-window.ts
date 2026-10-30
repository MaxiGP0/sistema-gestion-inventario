/**
 * Ventana de render de las bandejas largas.
 *
 * El listado puede acumular muchas páginas al tocar "Cargar más". Para que el
 * DOM no crezca sin techo se renderizan como máximo las últimas 200 tarjetas
 * cargadas: las páginas nuevas se anexan y las más viejas salen del DOM. La
 * altura de la ventana es constante, así el botón de "Cargar más" (que vive al
 * final) conserva la posición del scroll en vez de saltar al principio.
 *
 * No es virtualización: las tarjetas visibles siguen siendo nodos reales y
 * `content-visibility` se encarga de la pintura. Solo se acota la acumulación.
 */
export const MAX_RENDERED_ORDERS = 200;

export interface OrderRenderWindow<T> {
  /** Tarjetas que deben renderizarse (como máximo `limit`). */
  orders: T[];
  /** Índice de la primera tarjeta visible dentro del listado acumulado. */
  start: number;
  /** Cantidad de pedidos cargados en memoria (incluye los que salieron de la ventana). */
  loaded: number;
  limit: number;
}

export function getOrderRenderWindow<T>(
  orders: readonly T[],
  limit = MAX_RENDERED_ORDERS,
): OrderRenderWindow<T> {
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : MAX_RENDERED_ORDERS;
  const start = Math.max(0, orders.length - safeLimit);

  return {
    orders: orders.slice(start),
    start,
    loaded: orders.length,
    limit: safeLimit,
  };
}
