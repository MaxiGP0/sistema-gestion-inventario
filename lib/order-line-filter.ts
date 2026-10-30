/**
 * Filtros rápidos de líneas dentro del detalle de un pedido.
 *
 * Depósito y facturación comparten los chips ("Todas / Pendientes / Con
 * diferencia") y el buscador liviano por código o nombre. Las reglas de qué es
 * una línea pendiente o con diferencia las define cada pantalla; este módulo
 * sólo se ocupa del conteo, la búsqueda y el filtrado.
 *
 * Módulo puro (sin React ni Next) para poder probarlo con `node:test`.
 */

export type OrderLineFilter = 'all' | 'pending' | 'difference';

export interface OrderLineFilterItemLike {
  /** Identificador de la línea cuando la pantalla ya lo expone. */
  _id?: string;
  /** Alias liviano usado por pruebas y líneas todavía sin persistir. */
  id?: string;
  productCode?: string;
  productName?: string;
  productId?: { code?: string; name?: string } | null;
}

export interface OrderLineFilterPredicates<T> {
  isPending: (item: T) => boolean;
  hasDifference: (item: T) => boolean;
}

export interface OrderLineFilterCounts {
  all: number;
  pending: number;
  difference: number;
}

export interface OrderLineFilterSelection {
  filter: OrderLineFilter;
  query?: string;
  /**
   * Claves que se conservan visibles aunque ya no coincidan con el chip o la
   * búsqueda. La usa el detalle para no hacer desaparecer la tarjeta que el
   * operario está tocando (por ejemplo, al controlar una línea pendiente).
   */
  pinnedKeys?: ReadonlySet<string>;
}

/** Normaliza para comparar sin distinguir mayúsculas ni acentos. */
export function normalizeOrderLineSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Texto indexable de una línea: código y nombre, con respaldo en el producto. */
export function orderLineSearchText(item: OrderLineFilterItemLike): string {
  const code = item.productCode ?? item.productId?.code ?? '';
  const name = item.productName ?? item.productId?.name ?? '';
  return normalizeOrderLineSearch(`${code} ${name}`);
}

/**
 * Coincidencia por tokens: "prod 001" encuentra "Producto E2E 001". Las líneas
 * sin código/nombre (pedidos históricos incompletos) no rompen la búsqueda.
 */
export function matchesOrderLineSearch(
  item: OrderLineFilterItemLike,
  query: string | undefined,
): boolean {
  const normalized = normalizeOrderLineSearch(query ?? '');
  if (!normalized) return true;

  const haystack = orderLineSearchText(item);
  return normalized.split(/\s+/).every((token) => haystack.includes(token));
}

/** Conteos de los chips; se calculan sobre todas las líneas, no sobre el filtro. */
export function countOrderLineFilters<T extends OrderLineFilterItemLike>(
  items: readonly T[],
  predicates: OrderLineFilterPredicates<T>,
): OrderLineFilterCounts {
  let pending = 0;
  let difference = 0;

  items.forEach((item) => {
    if (predicates.isPending(item)) pending += 1;
    if (predicates.hasDifference(item)) difference += 1;
  });

  return { all: items.length, pending, difference };
}

/** Clave por defecto para pins cuando la pantalla no pasa un extractor. */
function defaultOrderLineKey(item: OrderLineFilterItemLike): string {
  return item._id?.trim() || item.id?.trim() || '';
}

/** Aplica chip + búsqueda manteniendo el orden original de las líneas. */
export function filterOrderLines<T extends OrderLineFilterItemLike>(
  items: readonly T[],
  selection: OrderLineFilterSelection,
  predicates: OrderLineFilterPredicates<T>,
  keyOf?: (item: T) => string,
): T[] {
  return items.filter((item) => {
    // Una línea activa se conserva hasta que el usuario cambie de chip,
    // búsqueda o toque otra tarjeta. Evita que el control desaparezca justo
    // después del toque que la sacó del filtro.
    const key = keyOf ? keyOf(item) : defaultOrderLineKey(item);
    if (key && selection.pinnedKeys?.has(key)) return true;

    if (!matchesOrderLineSearch(item, selection.query)) return false;

    if (selection.filter === 'pending') return predicates.isPending(item);
    if (selection.filter === 'difference') return predicates.hasDifference(item);
    return true;
  });
}
