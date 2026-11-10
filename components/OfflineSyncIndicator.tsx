'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ChevronRight,
  CloudUpload,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/context/ToastContext';
import { useUser } from '@/context/UserContext';
import { api } from '@/lib/api-client';
import {
  deletePendingOrderRequest,
  getPendingOrderRequests,
  OFFLINE_QUEUE_CHANGED_EVENT,
  resetPendingOrderRequest,
  type PendingOrderRequest,
} from '@/lib/offline-order-queue';
import { readOfflineCatalogClients } from '@/lib/offline-catalog';
import {
  isDraftEditQueueEntry,
  restoreOrderDraftFromQueueEntry,
} from '@/lib/offline-order-restore';
import type { OrderCatalogClient } from '@/lib/order-catalog';
import { buildPickingAutosaveFromOrderPut, savePickingAutosave } from '@/lib/picking-autosave';
import type { OrderDetailResponse } from '@/lib/types';
import { recordOfflineQueueSize, recordOfflineSyncResult } from '@/lib/observability/metrics';
import {
  flushPendingOrders,
  isOrderSyncMessage,
  requestOrderBackgroundSync,
  type OrderQueueSyncResult,
} from '@/lib/order-put-sync';

const QUEUE_DATE_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

const CURRENCY_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 2,
});

function formatQueueDate(timestamp: number): string {
  return QUEUE_DATE_FORMATTER.format(new Date(timestamp));
}

function formatQueueAmount(total: number | undefined): string | null {
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  return CURRENCY_FORMATTER.format(total);
}

function queueEntryClientId(entry: PendingOrderRequest): string {
  const body = entry.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const clientId = (body as Record<string, unknown>).clientId;
  return typeof clientId === 'string' ? clientId : '';
}

function queueEntryTitle(entry: PendingOrderRequest): string {
  if (entry.kind === 'create') return 'Alta de pedido';
  const reference = entry.orderId?.slice(-6) ?? entry.id.slice(-6);
  if (isDraftEditQueueEntry(entry)) return `Edición de borrador #${reference}`;
  return `Picking de pedido #${reference}`;
}

/** localStorage puede no estar disponible (SSR o modo privado). */
function resolveLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Indicador global de escrituras de pedidos guardadas offline (altas y
 * pickings).
 *
 * Se monta en el layout raíz para que el operario vea el pendiente incluso si
 * salió de la página de alta o depósito. Reintenta al recuperar conexión, al
 * volver a la pestaña, al recuperar foco y cuando el service worker despierta
 * por Background Sync. Al tocarlo abre la cola completa: los rechazos
 * permanentes quedan visibles hasta que el usuario los restaure o descarte.
 */
export default function OfflineSyncIndicator() {
  const [entries, setEntries] = useState<PendingOrderRequest[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<PendingOrderRequest | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
  const syncingRef = useRef(false);
  const mountedRef = useRef(true);
  const { showToast } = useToast();
  const { user } = useUser();
  const router = useRouter();

  const pending = entries.length;
  const failedCount = entries.filter((entry) => entry.status === 'failed').length;
  const pendingOnlyCount = pending - failedCount;
  const indicatorVisible = syncing || pending > 0;

  const refreshQueue = useCallback(async (): Promise<PendingOrderRequest[]> => {
    try {
      const next = await getPendingOrderRequests();
      if (mountedRef.current) setEntries(next);
      return next;
    } catch (error) {
      console.error('No se pudo leer la cola offline:', error);
      return [];
    }
  }, []);

  const reportResult = useCallback(
    (result: OrderQueueSyncResult, manual: boolean) => {
      const permanentFailures = result.failed.filter((failure) => !failure.retryable);

      if (permanentFailures.length > 0) {
        const first = permanentFailures[0];
        const reference = first.orderId ?? first.clientRequestId ?? first.requestId;
        const label = first.kind === 'create' ? 'el pedido nuevo' : 'el pedido';
        const message =
          permanentFailures.length === 1
            ? `No se pudo sincronizar ${label} #${reference.slice(-6)}: ${first.message}`
            : `${permanentFailures.length} pedidos no se pudieron sincronizar. ${first.message}`;
        showToast(message, 'error', 8000);
        return;
      }

      if (result.synced > 0) {
        showToast(
          result.synced === 1
            ? 'Pedido sincronizado con el servidor.'
            : `${result.synced} pedidos sincronizados con el servidor.`,
          'success',
        );
        return;
      }

      if (manual && result.failed.length > 0) {
        const first = result.failed[0];
        showToast(
          first.status === 401
            ? 'La sesión venció: iniciá sesión y volvé a reintentar la sincronización.'
            : `Todavía no se pudo sincronizar: ${first.message}`,
          'error',
          7000,
        );
      }
    },
    [showToast],
  );

  const runSync = useCallback(
    async (manual = false) => {
      if (syncingRef.current) return;

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setOnline(false);
        await refreshQueue();
        return;
      }

      // Las entradas fallidas no se reenvían solas: sólo se procesan las
      // pendientes. Si no hay ninguna, no se hace ningún request.
      const current = await refreshQueue();
      if (!current.some((entry) => entry.status !== 'failed')) return;

      syncingRef.current = true;
      setSyncing(true);

      try {
        const result = await flushPendingOrders();
        if (!mountedRef.current) return;

        const next = await refreshQueue();
        recordOfflineSyncResult({
          synced: result.synced,
          failed: result.failed.length,
          pending: next.length,
          retryableFailures: result.failed.filter((failure) => failure.retryable).length,
        });
        reportResult(result, manual);
      } catch (error) {
        console.error('Error sincronizando pedidos offline:', error);
        if (manual && mountedRef.current) {
          showToast('No se pudo acceder a la cola local de sincronización.', 'error');
        }
        await refreshQueue();
      } finally {
        syncingRef.current = false;
        if (mountedRef.current) setSyncing(false);
      }
    },
    [refreshQueue, reportResult, showToast],
  );

  useEffect(() => {
    mountedRef.current = true;

    if (typeof window === 'undefined') return;

    setOnline(navigator.onLine);

    const refreshAndMaybeSync = async () => {
      const current = await refreshQueue();
      if (current.length === 0) return;

      if (navigator.onLine) {
        await runSync();
      } else if (current.some((entry) => entry.status !== 'failed')) {
        // Sin conexión igual conviene dejar registrado el pedido de sync para
        // que el service worker despierte cuando el navegador lo permita.
        void requestOrderBackgroundSync();
      }
    };

    void refreshAndMaybeSync();

    const handleOnline = () => {
      setOnline(true);
      void runSync();
    };

    const handleOffline = () => {
      setOnline(false);
    };

    const handleQueueChanged = () => {
      void refreshQueue();
    };

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (isOrderSyncMessage(event.data)) {
        void runSync();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshAndMaybeSync();
    };

    // Recuperar foco (cambio de app/ventana) es una señal más frecuente que
    // visibilitychange en el celular del vendedor.
    const handleFocus = () => {
      void refreshAndMaybeSync();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleFocus);
    window.addEventListener(OFFLINE_QUEUE_CHANGED_EVENT, handleQueueChanged);
    window.addEventListener('visibilitychange', handleVisibilityChange);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    }

    return () => {
      mountedRef.current = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(OFFLINE_QUEUE_CHANGED_EVENT, handleQueueChanged);
      window.removeEventListener('visibilitychange', handleVisibilityChange);

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
      }
    };
  }, [refreshQueue, runSync]);

  // Cada vez que aparece una entrada nueva reintentable, se registra el tag de
  // Background Sync. Las fallidas esperan una decisión explícita del usuario.
  const hasRetryableEntries = pendingOnlyCount > 0;
  useEffect(() => {
    if (hasRetryableEntries) {
      void requestOrderBackgroundSync();
    }
  }, [hasRetryableEntries]);

  // Si la cola se vacía mientras el detalle está abierto (por ejemplo, al
  // sincronizar las pendientes), se cierra para no dejar un modal vacío.
  useEffect(() => {
    if (queueOpen && pending === 0 && !syncing) setQueueOpen(false);
  }, [queueOpen, pending, syncing]);

  // Gauge de la cola offline: queda asociado a la sesión del navegador y
  // permite alertar si crece de forma sostenida.
  useEffect(() => {
    recordOfflineQueueSize(pending, { online, syncing });
  }, [pending, online, syncing]);

  // Señal de disponibilidad para los E2E: si el navegador pasa a offline antes
  // de que se descargue este chunk dinámico, el import falla y la cola queda
  // inaccesible. Los tests esperan esta marca antes de simular un corte.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.offlineSyncReady = 'true';

    return () => {
      delete root.dataset.offlineSyncReady;
    };
  }, []);

  // Marca en <html> que la píldora ocupa la primera capa inferior. El CSS
  // sube el resto de avisos (chip SSE, SW y toast) para que se apilen sin
  // compartir coordenada con este indicador.
  useEffect(() => {
    if (!indicatorVisible) return;

    const root = document.documentElement;
    root.dataset.offlineSyncVisible = 'true';

    return () => {
      delete root.dataset.offlineSyncVisible;
    };
  }, [indicatorVisible]);

  // El detalle necesita el nombre del cliente incluso en entradas viejas que no
  // guardaron metadata. Se resuelve contra el snapshot offline del usuario.
  useEffect(() => {
    if (!queueOpen || !user?.id) return;

    let active = true;
    void readOfflineCatalogClients(user.id)
      .then((snapshot) => {
        if (!active) return;
        const next: Record<string, string> = {};
        for (const client of snapshot.items) next[client._id] = client.name;
        setClientNames(next);
      })
      .catch(() => {
        // Sin snapshot el detalle cae al nombre guardado al encolar.
      });

    return () => {
      active = false;
    };
  }, [queueOpen, user?.id]);

  const openQueue = () => {
    setQueueOpen(true);
    void refreshQueue();
  };

  const handleRetry = async (entry: PendingOrderRequest) => {
    if (busyRequestId) return;

    setBusyRequestId(entry.id);
    try {
      await resetPendingOrderRequest(entry.id);
      await runSync(true);
    } catch (error) {
      console.error('No se pudo reintentar la entrada offline:', error);
      showToast('No se pudo reintentar el cambio guardado.', 'error');
    } finally {
      setBusyRequestId(null);
    }
  };

  const handleRestoreDraft = async (entry: PendingOrderRequest) => {
    if (busyRequestId) return;

    if (!user?.id) {
      showToast('No se pudo identificar la sesión para restaurar el borrador.', 'error');
      return;
    }

    setBusyRequestId(entry.id);
    try {
      let knownClients: OrderCatalogClient[] = [];
      try {
        const snapshot = await readOfflineCatalogClients(user.id);
        knownClients = snapshot.items as OrderCatalogClient[];
      } catch {
        // El body y el nombre guardado alcanzan para reconstruir el borrador.
      }

      const storage = (() => {
        try {
          return window.localStorage;
        } catch {
          return null;
        }
      })();

      const isDraftEdit = isDraftEditQueueEntry(entry);
      const targetOrderId = isDraftEdit ? entry.orderId : undefined;

      const restored = restoreOrderDraftFromQueueEntry(
        {
          userId: user.id,
          salesperson: user.username,
          knownClients,
          storage,
          orderId: targetOrderId,
        },
        entry,
      );

      if (!restored) {
        showToast(
          'No se pudo restaurar el pedido en el borrador. Revisá el almacenamiento del navegador.',
          'error',
          8000,
        );
        return;
      }

      // Sólo se borra la entrada después de que el borrador quedó guardado.
      await deletePendingOrderRequest(entry.id);
      setQueueOpen(false);
      showToast(
        isDraftEdit
          ? 'Cambios restaurados en el borrador de edición. Revisá el pedido antes de guardar.'
          : 'Pedido restaurado en el borrador. Revisá el cliente y los productos antes de guardar.',
        'success',
        8000,
      );

      const targetPath =
        isDraftEdit && targetOrderId ? `/orders/${targetOrderId}/edit` : '/orders/new';

      if (window.location.pathname === targetPath) {
        window.location.reload();
      } else {
        router.push(targetPath);
      }
    } catch (error) {
      console.error('No se pudo restaurar el pedido fallido:', error);
      showToast('No se pudo restaurar el pedido guardado.', 'error');
    } finally {
      setBusyRequestId(null);
    }
  };

  /**
   * Un PUT de picking rechazado con 409 conserva las cantidades tipeadas en la
   * cola. Se leen contra la versión vigente del servidor, se guardan como
   * autosave y se abre el pedido para que el operario revise y guarde sin
   * volver a cargar las cantidades.
   */
  const handleRestorePickingControl = async (entry: PendingOrderRequest) => {
    if (busyRequestId || !entry.orderId) return;

    if (!user?.id) {
      showToast('No se pudo identificar la sesión para restaurar el control.', 'error');
      return;
    }

    const orderId = entry.orderId;
    setBusyRequestId(entry.id);

    try {
      const data = await api.get<OrderDetailResponse>(`/api/orders/${orderId}`);
      const bodyItems =
        entry.body && typeof entry.body === 'object' && !Array.isArray(entry.body)
          ? (entry.body as { items?: unknown }).items
          : undefined;

      const snapshot = buildPickingAutosaveFromOrderPut({
        orderId,
        userId: user.id,
        version: data.order.version ?? 0,
        items: bodyItems,
      });

      if (!snapshot) {
        showToast(
          'El cambio guardado no tiene cantidades de picking para restaurar. Abrí el pedido actual para controlarlo.',
          'error',
          8000,
        );
        return;
      }

      if (!savePickingAutosave(resolveLocalStorage(), snapshot)) {
        showToast(
          'No se pudo guardar el control en este dispositivo. Revisá el almacenamiento del navegador.',
          'error',
          8000,
        );
        return;
      }

      await deletePendingOrderRequest(entry.id);
      setQueueOpen(false);
      showToast(
        'Control restaurado sobre la versión vigente. Revisá las cantidades y guardá el picking.',
        'success',
        8000,
      );
      router.push(`/deposit/orders/${orderId}`);
    } catch (error) {
      console.error('No se pudo restaurar el control del pedido fallido:', error);
      showToast(
        error instanceof Error ? error.message : 'No se pudo restaurar el control guardado.',
        'error',
        8000,
      );
    } finally {
      setBusyRequestId(null);
    }
  };

  const handleDiscard = async () => {
    if (!discardTarget) return;

    try {
      await deletePendingOrderRequest(discardTarget.id);
      showToast('Cambio descartado de la cola de sincronización.', 'success');
    } catch (error) {
      console.error('No se pudo descartar la entrada offline:', error);
      showToast('No se pudo descartar el cambio guardado.', 'error');
    } finally {
      setDiscardTarget(null);
    }
  };

  const openCurrentOrder = (orderId: string, isDraftEdit = false) => {
    setQueueOpen(false);
    router.push(isDraftEdit ? `/orders/${orderId}` : `/deposit/orders/${orderId}`);
  };

  if (!indicatorVisible) return null;

  const failedLabel = failedCount === 1 ? '1 cambio con error' : `${failedCount} cambios con error`;
  const pendingLabel =
    pendingOnlyCount === 1 ? '1 cambio pendiente' : `${pendingOnlyCount} cambios pendientes`;

  const statusLabel = failedCount
    ? `${failedLabel}${pendingOnlyCount > 0 ? ` · ${pendingOnlyCount} pendiente${pendingOnlyCount === 1 ? '' : 's'}` : ''}`
    : syncing
      ? 'Sincronizando cambios...'
      : online
        ? `${pendingLabel} de sincronizar`
        : `${pendingLabel} guardados sin conexión`;

  const containerClass =
    failedCount > 0
      ? 'border-status-blocked-border bg-status-blocked-soft text-status-blocked'
      : syncing
        ? 'border-action/40 bg-action-soft text-action-text'
        : online
          ? 'border-status-draft-border bg-status-draft-soft text-status-draft'
          : 'border-border-strong bg-surface text-muted';

  return (
    <>
      <div
        data-testid="offline-sync-indicator-wrapper"
        className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+var(--mobile-sync-clearance))] z-40 max-w-[calc(100vw-1.5rem)] transition-all duration-200 motion-reduce:transition-none [html[data-mobile-keyboard='open']_&]:pointer-events-none [html[data-mobile-keyboard='open']_&]:translate-y-2 [html[data-mobile-keyboard='open']_&]:opacity-0 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:max-w-[calc(100vw-2rem)]"
        role="status"
        aria-live="polite"
      >
        <div
          className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium shadow-elevation-2 backdrop-blur-md sm:gap-2 sm:px-3 sm:py-2 sm:text-sm ${containerClass}`}
        >
          <button
            type="button"
            onClick={openQueue}
            data-testid="offline-sync-indicator"
            aria-haspopup="dialog"
            aria-label="Abrir cola de sincronización"
            className="-mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11"
          >
            {failedCount > 0 ? (
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : syncing ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : online ? (
              <CloudUpload className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}

            <span className="min-w-0 flex-1">{statusLabel}</span>
            <ChevronRight className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
          </button>

          {!syncing && online && pendingOnlyCount > 0 && (
            <button
              type="button"
              onClick={() => void runSync(true)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-status-draft-border bg-status-draft-soft px-2 py-1 text-[11px] font-semibold text-status-draft transition-colors hover:brightness-95 max-sm:min-h-11 max-sm:px-3"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Reintentar
            </button>
          )}
        </div>
      </div>

      <Modal
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        labelledBy="offline-queue-title"
        size="md"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="offline-queue-title" className="text-base font-semibold text-foreground">
              Cola de sincronización
            </h2>
            <p className="mt-1 text-xs text-muted sm:text-sm">
              Los cambios con error no se reenvían solos. Restauralos o descartalos para liberar la
              cola.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setQueueOpen(false)}
            aria-label="Cerrar cola de sincronización"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="mt-6 text-sm text-muted">No hay cambios pendientes de sincronización.</p>
        ) : (
          <ul className="mt-4 space-y-3" data-testid="offline-queue-list">
            {entries.map((entry) => {
              const failed = entry.status === 'failed';
              const entrySyncing = syncing && !failed;
              const clientId = queueEntryClientId(entry);
              const clientName = entry.clientName ?? clientNames[clientId];
              const amount = formatQueueAmount(entry.total);
              const busy = busyRequestId === entry.id;

              return (
                <li
                  key={entry.id}
                  data-testid="offline-queue-item"
                  className={`rounded-lg border p-3 ${
                    failed
                      ? 'border-status-blocked-border bg-status-blocked-soft'
                      : 'border-border bg-surface-muted'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 shrink-0 rounded-md p-2 ${
                        failed
                          ? 'bg-status-blocked-soft text-status-blocked'
                          : 'bg-action-soft text-action-text'
                      }`}
                    >
                      {entry.kind === 'create' ? (
                        <FileText className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Package className="h-4 w-4" aria-hidden="true" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{queueEntryTitle(entry)}</p>
                          <p className="mt-0.5 text-[11px] text-subtle sm:text-xs">
                            {formatQueueDate(entry.createdAt)}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            failed
                              ? 'bg-status-blocked-soft text-status-blocked'
                              : entrySyncing
                                ? 'bg-action-soft text-action-text'
                                : 'bg-status-draft-soft text-status-draft'
                          }`}
                        >
                          {failed ? 'Error' : entrySyncing ? 'Sincronizando' : 'Pendiente'}
                        </span>
                      </div>

                      <p className="mt-2 break-words text-xs text-muted">
                        <span className="font-medium text-foreground">
                          {clientName || 'Cliente sin identificar'}
                        </span>
                        <span className="text-subtle"> · </span>
                        {amount ?? 'Importe no disponible'}
                      </p>

                      {failed && (
                        <div className="mt-2 rounded-md border border-status-blocked-border bg-surface px-2.5 py-2 text-xs text-status-blocked">
                          <p className="break-words">
                            {entry.lastError?.trim() || 'El servidor rechazó este cambio.'}
                          </p>
                          <p className="mt-1 text-[11px] opacity-80">
                            {entry.lastStatus ? `HTTP ${entry.lastStatus}` : 'Rechazo permanente'}
                            {entry.lastAttemptAt
                              ? ` · ${formatQueueDate(entry.lastAttemptAt)}`
                              : ''}
                          </p>
                        </div>
                      )}

                      {!failed && entry.lastError && (
                        <p className="mt-2 break-words text-[11px] text-muted">
                          Último intento: {entry.lastError}
                        </p>
                      )}

                      {failed && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {entry.kind === 'create' && (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => void handleRestoreDraft(entry)}
                                disabled={busy}
                              >
                                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                {busy ? 'Restaurando...' : 'Restaurar en borrador'}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => void handleRetry(entry)}
                                disabled={busy || syncing}
                              >
                                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                Reintentar
                              </Button>
                            </>
                          )}

                          {entry.kind === 'update' &&
                            entry.orderId &&
                            isDraftEditQueueEntry(entry) && (
                              <>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => void handleRestoreDraft(entry)}
                                  disabled={busy}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                  {busy ? 'Restaurando...' : 'Restaurar en borrador'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => openCurrentOrder(entry.orderId!, true)}
                                  disabled={busy}
                                >
                                  Abrir pedido actual
                                </Button>
                              </>
                            )}

                          {entry.kind === 'update' &&
                            entry.orderId &&
                            !isDraftEditQueueEntry(entry) && (
                              <>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => void handleRestorePickingControl(entry)}
                                  disabled={busy}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                  {busy ? 'Restaurando...' : 'Restaurar control en el pedido'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => openCurrentOrder(entry.orderId!, false)}
                                  disabled={busy}
                                >
                                  Abrir pedido actual
                                </Button>
                              </>
                            )}

                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setDiscardTarget(entry)}
                            disabled={busy}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Descartar
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={discardTarget !== null}
        title="Descartar cambio"
        message={
          discardTarget
            ? `Se eliminará de este dispositivo "${queueEntryTitle(discardTarget)}" y no se enviará al servidor. Esta acción no se puede deshacer.`
            : ''
        }
        confirmLabel="Descartar"
        onConfirm={handleDiscard}
        onClose={() => setDiscardTarget(null)}
      />
    </>
  );
}
