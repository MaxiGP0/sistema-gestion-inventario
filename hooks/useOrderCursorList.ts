'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isAbortError } from '@/lib/api-client';
import { getOrderRenderWindow, MAX_RENDERED_ORDERS } from '@/lib/order-list-window';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { buildOrdersListSearchParams } from '@/lib/orders-tray';
import {
  isOrderInitialDataStale,
  ORDER_INITIAL_DATA_STALE_MS,
  type InitialOrderListData,
} from '@/lib/order-initial-data';
import type { OrderCursorListResponse, OrderSummaryDTO } from '@/lib/types';

const PAGE_SIZE = 50;

interface OrderListFilters {
  /** Estados separados por coma, tal como los acepta GET /api/orders. */
  status: string;
  archived: boolean;
  /** Término de búsqueda libre (se aplica con debounce). */
  search: string;
  /** Rango ISO del filtro rápido de fechas; `null` no acota. */
  startDate: string | null;
  endDate: string | null;
}

export interface UseOrderCursorListOptions extends OrderListFilters {
  /** Primera página resuelta por el Server Component. */
  initialData?: InitialOrderListData | null;
  /** Edad a partir de la cual la data inicial se revalida en segundo plano. */
  staleAfterMs?: number;
}

interface FetchOptions {
  cursor?: string | null;
  append?: boolean;
  manual?: boolean;
  /** Refresco en segundo plano: no cambia `loading`/`refreshing`. */
  silent?: boolean;
}

export interface OrderCursorList {
  /** Listado acumulado completo (puede superar la ventana de render). */
  orders: OrderSummaryDTO[];
  /** Tarjetas que se renderizan: como máximo `MAX_RENDERED_ORDERS`. */
  visibleOrders: OrderSummaryDTO[];
  /** Índice de `visibleOrders[0]` dentro de `orders` (para el rango visible). */
  windowStart: number;
  renderedLimit: number;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  /** Total de la primera página; se conserva al anexar páginas siguientes. */
  total: number | null;
  hasMore: boolean;
  refresh: () => void;
  /** Reemplaza la primera página sin mostrar spinners ni bloquear la lista. */
  refreshSilently: () => void;
  loadMore: () => void;
  /** Quita una tarjeta ya archivada/eliminada y ajusta el total mostrado. */
  removeOrder: (orderId: string) => void;
}

function filterSignature(
  status: string,
  archived: boolean,
  search: string,
  startDate: string | null,
  endDate: string | null,
): string {
  return `${status}\u0000${archived}\u0000${search.trim()}\u0000${startDate ?? ''}\u0000${endDate ?? ''}`;
}

/**
 * Listado de pedidos con paginación por cursor (`createdAt`/`_id`) y carga
 * incremental. La primera página puede venir del Server Component: en ese caso
 * no se repite el fetch al hidratar y sólo se refresca en segundo plano si el
 * payload ya es viejo.
 */
export function useOrderCursorList({
  status,
  archived,
  search,
  startDate,
  endDate,
  initialData = null,
  staleAfterMs = ORDER_INITIAL_DATA_STALE_MS,
}: UseOrderCursorListOptions): OrderCursorList {
  // La data inicial corresponde a la primera página activa. Si el servidor
  // dejó registrados los filtros con los que la resolvió, se comparan todos
  // (incluidos fecha y archivados); si no, se conserva la regla histórica de
  // aceptarla sólo para la vista limpia sin búsqueda ni rango.
  const initialFilters = initialData?.filters;
  const initialMatchesFilters =
    Boolean(initialData) &&
    (initialFilters
      ? initialFilters.status === status &&
        initialFilters.archived === archived &&
        initialFilters.search === search.trim() &&
        initialFilters.startDate === startDate &&
        initialFilters.endDate === endDate
      : !archived && !search.trim() && !startDate && !endDate);
  const usableInitialData = initialMatchesFilters ? initialData : null;

  const [orders, setOrders] = useState<OrderSummaryDTO[]>(() => usableInitialData?.orders ?? []);
  const [loading, setLoading] = useState(() => !usableInitialData);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState<number | null>(() => usableInitialData?.total ?? null);
  const [hasMore, setHasMore] = useState(() => Boolean(usableInitialData?.nextCursor));
  const [nextCursor, setNextCursor] = useState<string | null>(
    () => usableInitialData?.nextCursor ?? null,
  );
  const latestRequest = useLatestRequest();

  const initialDataRef = useRef(usableInitialData);
  const initialSignatureRef = useRef(filterSignature(status, archived, search, startDate, endDate));
  const leftInitialFiltersRef = useRef(false);
  const backgroundRefreshStartedRef = useRef(false);

  const fetchOrders = useCallback(
    async ({
      cursor = null,
      append = false,
      manual = false,
      silent = false,
    }: FetchOptions = {}) => {
      // Aborta la consulta anterior y conserva el id como segunda barrera para
      // descartar respuestas que ya estaban en vuelo.
      const ticket = latestRequest.start();
      // Refresco disparado por SSE: la lista visible no se tapa ni se marca
      // como "Actualizando" para no interrumpir al usuario.
      if (!silent) {
        if (manual) setRefreshing(true);
        else if (append) setLoadingMore(true);
        else setLoading(true);
      }

      try {
        const params = buildOrdersListSearchParams({
          status,
          archived,
          search,
          startDate,
          endDate,
          limit: PAGE_SIZE,
          cursor,
        });

        const data = await api.get<OrderCursorListResponse>(`/api/orders?${params.toString()}`, {
          signal: ticket.signal,
        });

        // Descartar respuestas obsoletas (reemplazadas por una búsqueda o
        // actualización más reciente) o canceladas.
        if (!latestRequest.isCurrent(ticket)) return;

        const incoming = data.orders;
        setOrders((prev) => {
          if (!append) return incoming;
          const seen = new Set(prev.map((order) => order._id));
          return [...prev, ...incoming.filter((order) => !seen.has(order._id))];
        });

        const { pagination } = data;
        setNextCursor(pagination.nextCursor ?? null);
        setHasMore(Boolean(pagination.hasMore && pagination.nextCursor));
        if (typeof pagination.total === 'number') setTotal(pagination.total);
      } catch (err) {
        if (isAbortError(err) || !latestRequest.isCurrent(ticket)) return;
        console.error('Error cargando pedidos:', err);
      } finally {
        if (latestRequest.isCurrent(ticket)) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [status, archived, search, startDate, endDate, latestRequest],
  );

  useEffect(() => {
    const signature = filterSignature(status, archived, search, startDate, endDate);
    const isInitialFilter = signature === initialSignatureRef.current;

    if (!isInitialFilter) leftInitialFiltersRef.current = true;

    // Primera pintura con datos del servidor: no se repite el fetch. Si el
    // payload ya es viejo, se refresca en segundo plano sin tapar las tarjetas.
    // El timer de 0 ms evita duplicar la consulta si React re-ejecuta el efecto
    // (Strict Mode en desarrollo) y se cancela si el componente se desmonta.
    if (initialDataRef.current && !leftInitialFiltersRef.current && isInitialFilter) {
      if (
        !backgroundRefreshStartedRef.current &&
        isOrderInitialDataStale(initialDataRef.current.fetchedAt, Date.now(), staleAfterMs)
      ) {
        const timer = setTimeout(() => {
          backgroundRefreshStartedRef.current = true;
          void fetchOrders({ manual: true });
        }, 0);

        return () => clearTimeout(timer);
      }

      return;
    }

    // Mismo debounce que usaban las bandejas para el buscador. Al cambiar de
    // filtro se cancela de inmediato la consulta anterior, sin esperar al
    // debounce; al desmontar también se aborta.
    const timer = setTimeout(() => {
      void fetchOrders();
    }, 300);
    return () => {
      clearTimeout(timer);
      latestRequest.abort();
    };
  }, [status, archived, search, startDate, endDate, fetchOrders, latestRequest, staleAfterMs]);

  const refresh = useCallback(() => {
    fetchOrders({ manual: true });
  }, [fetchOrders]);

  const refreshSilently = useCallback(() => {
    fetchOrders({ silent: true });
  }, [fetchOrders]);

  const loadMore = useCallback(() => {
    if (loading || refreshing || loadingMore || !hasMore || !nextCursor) return;
    fetchOrders({ cursor: nextCursor, append: true });
  }, [fetchOrders, hasMore, loading, loadingMore, nextCursor, refreshing]);

  const removeOrder = useCallback((orderId: string) => {
    setOrders((prev) => prev.filter((order) => order._id !== orderId));
    setTotal((current) => (typeof current === 'number' ? Math.max(0, current - 1) : current));
  }, []);

  // Acota el DOM sin perder las páginas ya cargadas: al superar el límite se
  // muestran las últimas 200 tarjetas y las más viejas salen de la ventana.
  const renderWindow = useMemo(() => getOrderRenderWindow(orders, MAX_RENDERED_ORDERS), [orders]);

  return {
    orders,
    visibleOrders: renderWindow.orders,
    windowStart: renderWindow.start,
    renderedLimit: renderWindow.limit,
    loading,
    refreshing,
    loadingMore,
    total,
    hasMore,
    refresh,
    refreshSilently,
    loadMore,
    removeOrder,
  };
}
