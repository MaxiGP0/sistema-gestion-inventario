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
  /** Snapshot de la marca al crear el pedido. */
  brandName?: string;
  productId?: {
    code?: string;
    name?: string;
    brandId?: { name?: string } | null;
  } | null;
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
   * Marca seleccionada. `undefined` y `'all'` muestran todas; cualquier otro
   * valor filtra por el nombre de marca de la línea.
   */
  brandName?: string;
  /**
   * Claves que se conservan visibles aunque ya no coincidan con el chip o la
   * búsqueda. La usa el detalle para no hacer desaparecer la tarjeta que el
   * operario está tocando (por ejemplo, al controlar una línea pendiente).
   */
  pinnedKeys?: ReadonlySet<string>;
}

export interface OrderLineBrandCount {
  name: string;
  count: number;
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

/** Marca visible de una línea, con respaldo en el producto poblado. */
export function orderLineBrandName(item: OrderLineFilterItemLike): string {
  return (item.brandName ?? item.productId?.brandId?.name ?? '').trim();
}

/**
 * Marcas únicas del pedido con la cantidad de líneas de cada una. Se ordenan
 * alfabéticamente para que los chips mantengan siempre la misma posición.
 */
export function extractOrderLineBrands<T extends OrderLineFilterItemLike>(
  items: readonly T[],
): OrderLineBrandCount[] {
  const counts = new Map<string, number>();

  items.forEach((item) => {
    const name = orderLineBrandName(item);
    if (!name) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));
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

    if (selection.brandName && selection.brandName !== 'all') {
      const lineBrand = normalizeOrderLineSearch(orderLineBrandName(item));
      if (!lineBrand || lineBrand !== normalizeOrderLineSearch(selection.brandName)) {
        return false;
      }
    }

    if (selection.filter === 'pending') return predicates.isPending(item);
    if (selection.filter === 'difference') return predicates.hasDifference(item);
    return true;
  });
}
