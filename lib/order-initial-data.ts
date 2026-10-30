import type { OrderDTO, OrderSummaryDTO } from './types';

/**
 * Datos iniciales que un Server Component entrega a la isla cliente.
 *
 * `fetchedAt` es el instante (epoch ms) en que el servidor leyó los datos. Al
 * hidratar, el cliente compara ese valor con el reloj actual: si pasó demasiado
 * tiempo (por ejemplo, una navegación con un payload RSC prefetcheado), refresca
 * en segundo plano sin reemplazar la pintura por un spinner.
 */
export const ORDER_INITIAL_DATA_STALE_MS = 30_000;

/** Filtros con los que el servidor resolvió la primera página. */
export interface InitialOrderListFilters {
  status: string;
  archived: boolean;
  search: string;
  startDate: string | null;
  endDate: string | null;
}

export interface InitialOrderListData {
  orders: OrderSummaryDTO[];
  total: number | null;
  nextCursor: string | null;
  fetchedAt: number;
  /** Permite reutilizar la data inicial aunque la URL traiga fecha/archivados. */
  filters?: InitialOrderListFilters;
}

export interface InitialOrderDetailData {
  order: OrderDTO | null;
  error: string | null;
  fetchedAt: number;
}

/** ¿La data inicial ya es vieja y conviene revalidarla en segundo plano? */
export function isOrderInitialDataStale(
  fetchedAt: number | undefined,
  now = Date.now(),
  maxAgeMs = ORDER_INITIAL_DATA_STALE_MS,
): boolean {
  if (!fetchedAt || !Number.isFinite(fetchedAt)) return true;

  return now - fetchedAt > maxAgeMs;
}

/** Mensaje visible para un detalle que el servidor no pudo resolver. */
export function initialOrderErrorForStatus(status: number): string {
  if (status === 403) return 'No tenés permiso para ver este pedido.';
  if (status === 404 || status === 400) return 'Pedido no encontrado.';

  return 'No se pudo cargar el pedido.';
}
