'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { api, ApiClientError } from '@/lib/api-client';
import { isOrderInitialDataStale, ORDER_INITIAL_DATA_STALE_MS } from '@/lib/order-initial-data';
import { subscribeToOrderNotifications } from '@/lib/order-notification-events';
import {
  canAutoMergeRemoteOrder,
  decideRemoteOrderUpdate,
  orderNotificationTargetsOrder,
  orderVersion,
} from '@/lib/order-live-sync';
import type { OrderDTO, OrderDetailResponse } from '@/lib/types';

export interface UseOrderDetailOptions<T extends { _id: string }> {
  /** Pedido ya resuelto por el Server Component. */
  initialOrder?: T | null;
  /** Error de lectura resuelto en el servidor (404/403, por ejemplo). */
  initialError?: string | null;
  /** Epoch ms de la lectura server-side. */
  initialFetchedAt?: number;
  staleAfterMs?: number;
  /**
   * Hay cambios locales sin guardar. Si una revalidación trae una versión más
   * nueva, el hook conserva la pintura local y expone la lectura en
   * `pendingOrder` para que la vista ofrezca cargarla explícitamente.
   */
  hasLocalChanges?: () => boolean;
  /** Se invoca cuando una revalidación reemplaza al pedido ya pintado. */
  onRemoteOrderApplied?: (remote: T, previous: T | null) => void;
  /**
   * Se invoca cuando una lectura remota sólo agregó comentarios: se actualiza
   * la versión y los comentarios sin tocar el trabajo local. La vista usa el
   * callback para alinear su `versionRef` o el autosave en curso.
   */
  onRemoteMetadataMerged?: (merged: T, previous: T | null) => void;
}

export interface UseOrderDetailState<T extends { _id: string }> {
  order: T | null;
  setOrder: Dispatch<SetStateAction<T | null>>;
  loading: boolean;
  /** Hay una revalidación silenciosa en curso; la pintura actual se conserva. */
  revalidating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Lectura más nueva que no se aplicó porque el usuario tenía cambios
   * locales. La vista puede mostrar el aviso de versión vencida.
   */
  pendingOrder: T | null;
  /** Aplica la lectura pendiente; la vista decide cuándo hacerlo. */
  applyPendingOrder: () => void;
}

function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'No tenés permiso para ver este pedido.';
    if (error.status === 404 || error.status === 400) return 'Pedido no encontrado.';
  }

  return 'No se pudo cargar el pedido.';
}

/** Conserva la pintura local y sólo adopta versión/comentarios de la remota. */
function mergeRemoteOrderMetadata<T extends { _id: string }>(previous: T, remote: T): T {
  const previousMetadata = previous as unknown as {
    version?: unknown;
    comments?: unknown;
  };
  const remoteMetadata = remote as unknown as {
    version?: unknown;
    comments?: unknown;
  };

  return {
    ...previous,
    version: remoteMetadata.version ?? previousMetadata.version,
    comments: remoteMetadata.comments ?? previousMetadata.comments,
  } as T;
}

/**
 * Detalle de pedido con datos iniciales del servidor.
 *
 * Con `initialOrder` no se muestra spinner ni se repite el GET al montar. Sólo
 * se revalida en segundo plano si el payload superó el TTL; sin datos iniciales
 * conserva el fetch de montaje anterior.
 *
 * También escucha las notificaciones SSE del pedido abierto y el regreso de la
 * pestaña a primer plano. Una revalidación nunca pisa cambios locales: si la
 * versión remota avanzó, queda pendiente hasta que la vista la confirme.
 */
export function useOrderDetail<T extends { _id: string } = OrderDTO>(
  orderId: string,
  options: UseOrderDetailOptions<T> = {},
): UseOrderDetailState<T> {
  const {
    initialOrder = null,
    initialError = null,
    staleAfterMs = ORDER_INITIAL_DATA_STALE_MS,
    hasLocalChanges,
    onRemoteOrderApplied,
    onRemoteMetadataMerged,
  } = options;

  const [order, setOrder] = useState<T | null>(() => initialOrder);
  const [pendingOrder, setPendingOrder] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(() => initialError);
  const [loading, setLoading] = useState(() => !initialOrder && !initialError);
  const [revalidating, setRevalidating] = useState(false);

  const hasOrderRef = useRef(Boolean(initialOrder));
  const orderRef = useRef<T | null>(initialOrder);
  const pendingOrderRef = useRef<T | null>(null);
  const startedForIdRef = useRef<string | null>(null);
  const hasLocalChangesRef = useRef(hasLocalChanges);
  const onRemoteOrderAppliedRef = useRef(onRemoteOrderApplied);
  const onRemoteMetadataMergedRef = useRef(onRemoteMetadataMerged);
  const initialRef = useRef({
    order: initialOrder,
    error: initialError,
    fetchedAt: options.initialFetchedAt ?? 0,
  });

  useEffect(() => {
    hasOrderRef.current = Boolean(order);
    orderRef.current = order;
  }, [order]);

  useEffect(() => {
    hasLocalChangesRef.current = hasLocalChanges;
  }, [hasLocalChanges]);

  useEffect(() => {
    onRemoteOrderAppliedRef.current = onRemoteOrderApplied;
  }, [onRemoteOrderApplied]);

  useEffect(() => {
    onRemoteMetadataMergedRef.current = onRemoteMetadataMerged;
  }, [onRemoteMetadataMerged]);

  const load = useCallback(
    async (background: boolean) => {
      if (background) setRevalidating(true);
      else setLoading(true);

      try {
        const data = await api.get<OrderDetailResponse>(`/api/orders/${orderId}`);
        const remote = data.order as unknown as T;
        const previous = orderRef.current;

        if (background && previous) {
          const decision = decideRemoteOrderUpdate({
            localVersion: orderVersion(previous),
            remoteVersion: orderVersion(remote),
            hasLocalChanges: hasLocalChangesRef.current?.() ?? false,
          });

          // Sin versión nueva no hace falta repintar; si hay cambios locales,
          // la lectura remota queda guardada para el botón de la vista.
          if (decision === 'ignore') {
            setError(null);
            return;
          }

          if (decision === 'stale') {
            // Si lo único que cambió fueron comentarios (y la versión), se
            // adopta la metadata remota sin pisar el picking local ni mostrar
            // el banner. Cualquier cambio real de líneas/estado sigue pendiente.
            if (previous && canAutoMergeRemoteOrder(previous, remote)) {
              const merged = mergeRemoteOrderMetadata(previous, remote);
              pendingOrderRef.current = null;
              setPendingOrder(null);
              setOrder(merged);
              orderRef.current = merged;
              hasOrderRef.current = true;
              setError(null);
              onRemoteMetadataMergedRef.current?.(merged, previous);
              return;
            }

            pendingOrderRef.current = remote;
            setPendingOrder(remote);
            setError(null);
            return;
          }
        }

        pendingOrderRef.current = null;
        setPendingOrder(null);
        setOrder(remote);
        orderRef.current = remote;
        hasOrderRef.current = true;
        setError(null);

        if (background && previous) {
          onRemoteOrderAppliedRef.current?.(remote, previous);
        }
      } catch (err: unknown) {
        // Una revalidación fallida no debe tapar un pedido que ya se está
        // mostrando: se conserva la pintura y el próximo refresh reintenta.
        if (!background || !hasOrderRef.current) {
          setError(detailErrorMessage(err));
        }
      } finally {
        setLoading(false);
        setRevalidating(false);
      }
    },
    [orderId],
  );

  useEffect(() => {
    // Strict Mode re-ejecuta los efectos en desarrollo: el id evita duplicar
    // la consulta y también cubre un cambio de pedido sin remount.
    if (startedForIdRef.current === orderId) return;
    startedForIdRef.current = orderId;

    const initial = initialRef.current;

    if (initial.order) {
      if (isOrderInitialDataStale(initial.fetchedAt, Date.now(), staleAfterMs)) {
        void load(true);
      }
      return;
    }

    // El servidor ya respondió 403/404: no tiene sentido repetir el GET.
    if (initial.error) return;

    void load(false);
  }, [load, orderId, staleAfterMs]);

  const refresh = useCallback(() => load(true), [load]);
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Puente SSE -> detalle: la campana ya filtró por rol y republicó el evento.
  // Con la pestaña oculta no se consulta; el regreso a foco hace la puesta al día.
  useEffect(() => {
    const unsubscribe = subscribeToOrderNotifications((detail) => {
      if (!orderNotificationTargetsOrder(detail, orderId)) return;
      if (typeof document !== 'undefined' && document.hidden) return;

      void refreshRef.current();
    });

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [orderId]);

  const applyPendingOrder = useCallback(() => {
    const remote = pendingOrderRef.current;
    if (!remote) return;

    const previous = orderRef.current;

    pendingOrderRef.current = null;
    setPendingOrder(null);
    setOrder(remote);
    orderRef.current = remote;
    hasOrderRef.current = true;
    onRemoteOrderAppliedRef.current?.(remote, previous);
  }, []);

  return {
    order,
    setOrder,
    loading,
    revalidating,
    error,
    refresh,
    pendingOrder,
    applyPendingOrder,
  };
}
