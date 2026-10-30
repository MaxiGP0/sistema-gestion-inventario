'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/context/ToastContext';
import { useOrderCursorList, type OrderCursorList } from '@/hooks/useOrderCursorList';
import {
  orderNotificationMatchesTray,
  subscribeToOrderNotifications,
} from '@/lib/order-notification-events';
import type { InitialOrderListData } from '@/lib/order-initial-data';
import {
  buildArchiveConfirmation,
  buildOrdersTrayFilterSearchParams,
  DELETE_CONFIRMATION,
  getOrdersTrayStatusParam,
  resolveOrdersTrayDateRange,
  saveOrdersTrayFilters,
  type OrdersTrayConfig,
  type OrdersTrayDatePreset,
  type OrdersTrayDateRange,
  type OrdersTrayStatusFilterValue,
} from '@/lib/orders-tray';
import { buildOrderExportUrl, type OrderExportFormat } from '@/lib/order-export';
import {
  canShareOrderExportFiles,
  downloadOrderExport,
  type OrderExportDownloadResult,
} from '@/lib/order-export-download';
import { api } from '@/lib/api-client';
import type { DeleteResponse, OrderMutationResponse } from '@/lib/types';

export interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'primary';
  run: () => Promise<void>;
}

export interface UseOrderTrayInitialFilters {
  /** Chip inicial resuelto desde `?status=...`. */
  status?: OrdersTrayStatusFilterValue;
  /** Fecha inicial resuelta desde `?date=...`. */
  datePreset?: OrdersTrayDatePreset;
  /** Vista de archivados resuelta desde `?archived=1`. */
  showArchived?: boolean;
}

interface UseOrderTrayResult extends OrderCursorList {
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  statusFilter: OrdersTrayStatusFilterValue;
  setStatusFilter: (value: OrdersTrayStatusFilterValue) => void;
  datePreset: OrdersTrayDatePreset;
  setDatePreset: (value: OrdersTrayDatePreset) => void;
  dateRange: OrdersTrayDateRange;
  showArchived: boolean;
  toggleArchived: () => void;
  /** Eventos SSE recibidos mientras el usuario escribía o confirmaba. */
  pendingNotificationCount: number;
  applyNotificationRefresh: () => void;
  pendingConfirm: PendingConfirm | null;
  setPendingConfirm: (confirmation: PendingConfirm | null) => void;
  confirmDeleteOrder: (orderId: string, event: React.MouseEvent) => void;
  confirmArchiveOrder: (
    orderId: string,
    currentArchived: boolean | undefined,
    version: number | undefined,
    event: React.MouseEvent,
  ) => void;
  confirmDuplicateOrder: (orderId: string, event: React.MouseEvent) => void;
  exportFormat: OrderExportFormat;
  setExportFormat: (format: OrderExportFormat) => void;
  /** El navegador puede compartir archivos del formato elegido. */
  canShareExport: boolean;
  exporting: boolean;
  sharingExport: boolean;
  exportOrders: () => Promise<void>;
  shareOrders: () => Promise<void>;
}

/** Repetir un pedido ya no crea otro: lo precarga para revisarlo y ajustarlo. */
const REPEAT_ORDER_CONFIRMATION = {
  title: 'Repetir pedido',
  message:
    'Se cargará el pedido en el formulario de alta para que ajustes cantidades y datos comerciales antes de guardar. ¿Continuar?',
  confirmLabel: 'Cargar en el carrito',
  variant: 'primary' as const,
};

/**
 * ¿El foco está en un campo editable? Durante el tipeo no conviene reemplazar
 * la lista debajo del usuario; el evento queda como chip para actualizar.
 */
function isEditableElementFocused(): boolean {
  if (typeof document === 'undefined') return false;

  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    Boolean(active.closest('input, textarea, select, [contenteditable="true"]'))
  );
}

/**
 * Estado y acciones compartidos por las bandejas de depósito y facturación:
 * búsqueda, sub-estado, rango rápido de fechas, filtro de archivados,
 * paginación por cursor y confirmaciones de archivar/eliminar.
 */
export function useOrderTray(
  config: OrdersTrayConfig,
  initialData?: InitialOrderListData | null,
  initialFilters: UseOrderTrayInitialFilters = {},
): UseOrderTrayResult {
  const { status, archiveEntity, statusFilters } = config;
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<OrdersTrayStatusFilterValue>(
    initialFilters.status ?? 'all',
  );
  const [datePreset, setDatePreset] = useState<OrdersTrayDatePreset>(
    initialFilters.datePreset ?? 'all',
  );
  const [showArchived, setShowArchived] = useState(initialFilters.showArchived ?? false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [pendingNotificationCount, setPendingNotificationCount] = useState(0);
  const [exportFormat, setExportFormat] = useState<OrderExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const [sharingExport, setSharingExport] = useState(false);
  // `navigator.canShare` sólo existe en el cliente; el botón aparece después
  // de hidratar para no romper la coincidencia SSR/CSR.
  const [canShareExport, setCanShareExport] = useState(false);
  const [, startTransition] = useTransition();
  // El input conserva su valor inmediato, pero la consulta y el listado usan
  // el valor diferido: React puede pintar la tecla antes de re-renderizar la
  // bandeja. Las tarjetas memoizadas evitan además re-renderizar cada fila.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const { showToast } = useToast();
  const router = useRouter();

  const statusParam = getOrdersTrayStatusParam({ status, statusFilters }, statusFilter);
  const dateRange = useMemo(() => resolveOrdersTrayDateRange(datePreset), [datePreset]);

  useEffect(() => {
    setCanShareExport(canShareOrderExportFiles(exportFormat));
  }, [exportFormat]);

  // La URL es la fuente de verdad al volver de un detalle: refleja los tres
  // filtros de la bandeja sin agregar entradas al historial ni recargar datos.
  // Además se guardan por pestaña para que el detalle sepa a qué estado volver.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const filters = { status: statusFilter, datePreset, showArchived };
    const params = buildOrdersTrayFilterSearchParams(
      filters,
      new URLSearchParams(window.location.search),
    );
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (currentUrl !== nextUrl) {
      window.history.replaceState(null, '', nextUrl);
    }

    saveOrdersTrayFilters(window.location.pathname, filters);
  }, [statusFilter, datePreset, showArchived]);

  const {
    orders,
    visibleOrders,
    windowStart,
    renderedLimit,
    loading,
    refreshing,
    loadingMore,
    total,
    hasMore,
    refresh,
    refreshSilently,
    loadMore,
    removeOrder,
  } = useOrderCursorList({
    status: statusParam,
    archived: showArchived,
    search: deferredSearchQuery,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    initialData,
  });

  const applyNotificationRefresh = useCallback(() => {
    setPendingNotificationCount(0);
    refreshSilently();
  }, [refreshSilently]);

  // Puente SSE -> bandeja: si el evento corresponde a este rol y el usuario no
  // está escribiendo ni confirmando, se reemplaza la primera página en
  // silencio. En caso contrario se acumula para el chip flotante.
  useEffect(
    () =>
      subscribeToOrderNotifications((detail) => {
        if (!orderNotificationMatchesTray(config.notificationsRole, detail.targetRole)) return;

        const busy =
          pendingConfirm !== null ||
          refreshing ||
          loadingMore ||
          document.hidden ||
          isEditableElementFocused();

        if (busy) {
          setPendingNotificationCount((count) => count + 1);
          return;
        }

        setPendingNotificationCount(0);
        refreshSilently();
      }),
    [config.notificationsRole, pendingConfirm, refreshing, loadingMore, refreshSilently],
  );

  const handleDeleteOrder = useCallback(
    async (orderId: string) => {
      try {
        const data = await api.delete<DeleteResponse>(`/api/orders/${orderId}`);

        removeOrder(orderId);
        showToast(data.message || 'Pedido eliminado exitosamente', 'success');
      } catch (err: unknown) {
        const error = err as Error;
        showToast(error.message || 'Error al eliminar el pedido', 'error');
      }
    },
    [removeOrder, showToast],
  );

  const handleArchiveOrder = useCallback(
    async (orderId: string, currentArchived: boolean | undefined, version: number | undefined) => {
      const newArchivedState = !currentArchived;

      try {
        await api.put<OrderMutationResponse>(`/api/orders/${orderId}`, {
          archived: newArchivedState,
          version: version ?? 0,
        });

        removeOrder(orderId);
        showToast(
          newArchivedState ? 'Pedido archivado exitosamente' : 'Pedido desarchivado exitosamente',
          'success',
        );
      } catch (err: unknown) {
        const error = err as Error;
        showToast(error.message || 'Error al archivar el pedido', 'error');
      }
    },
    [removeOrder, showToast],
  );

  const handleRepeatOrder = useCallback(
    async (orderId: string) => {
      router.push(`/orders/new?fromOrder=${orderId}`);
    },
    [router],
  );

  const confirmDeleteOrder = useCallback(
    (orderId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      setPendingConfirm({
        ...DELETE_CONFIRMATION,
        run: () => handleDeleteOrder(orderId),
      });
    },
    [handleDeleteOrder],
  );

  const confirmDuplicateOrder = useCallback(
    (orderId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      setPendingConfirm({
        ...REPEAT_ORDER_CONFIRMATION,
        run: () => handleRepeatOrder(orderId),
      });
    },
    [handleRepeatOrder],
  );

  const confirmArchiveOrder = useCallback(
    (
      orderId: string,
      currentArchived: boolean | undefined,
      version: number | undefined,
      event: React.MouseEvent,
    ) => {
      event.stopPropagation();
      setPendingConfirm({
        ...buildArchiveConfirmation(archiveEntity, currentArchived),
        run: () => handleArchiveOrder(orderId, currentArchived, version),
      });
    },
    [archiveEntity, handleArchiveOrder],
  );

  const toggleArchived = useCallback(() => {
    // El cambio de filtro no debe bloquear la interacción: la lista se
    // actualiza dentro de una transición.
    startTransition(() => setShowArchived((value) => !value));
  }, []);

  const buildCurrentExportUrl = useCallback(
    () =>
      buildOrderExportUrl(exportFormat, {
        status: statusParam,
        archived: showArchived ? 'true' : 'false',
        search: searchQuery,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      }),
    [dateRange.endDate, dateRange.startDate, exportFormat, searchQuery, showArchived, statusParam],
  );

  const notifyExportDelivery = useCallback(
    (result: OrderExportDownloadResult) => {
      if (result.delivery === 'shared') {
        showToast(`Archivo ${result.filename} compartido`, 'success');
      } else if (result.delivery === 'downloaded') {
        showToast(`Archivo ${result.filename} descargado`, 'success');
      }
      // Cancelar la hoja nativa no requiere aviso.
    },
    [showToast],
  );

  const exportOrders = useCallback(async () => {
    if (exporting || sharingExport) return;

    setExporting(true);
    try {
      const result = await downloadOrderExport(buildCurrentExportUrl(), exportFormat);
      notifyExportDelivery(result);
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message || 'No se pudieron exportar los pedidos', 'error');
    } finally {
      setExporting(false);
    }
  }, [
    buildCurrentExportUrl,
    exportFormat,
    exporting,
    notifyExportDelivery,
    sharingExport,
    showToast,
  ]);

  const shareOrders = useCallback(async () => {
    if (exporting || sharingExport) return;

    setSharingExport(true);
    try {
      const result = await downloadOrderExport(buildCurrentExportUrl(), exportFormat, {
        share: true,
        title: `Pedidos ${exportFormat === 'csv' ? 'CSV' : 'Excel'}`,
      });
      notifyExportDelivery(result);
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message || 'No se pudieron compartir los pedidos', 'error');
    } finally {
      setSharingExport(false);
    }
  }, [
    buildCurrentExportUrl,
    exportFormat,
    exporting,
    notifyExportDelivery,
    sharingExport,
    showToast,
  ]);

  return {
    orders,
    visibleOrders,
    windowStart,
    renderedLimit,
    loading,
    refreshing,
    loadingMore,
    total,
    hasMore,
    refresh,
    refreshSilently,
    loadMore,
    removeOrder,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    datePreset,
    setDatePreset,
    dateRange,
    showArchived,
    toggleArchived,
    pendingNotificationCount,
    applyNotificationRefresh,
    pendingConfirm,
    setPendingConfirm,
    confirmDeleteOrder,
    confirmArchiveOrder,
    confirmDuplicateOrder,
    exportFormat,
    setExportFormat,
    canShareExport,
    exporting,
    sharingExport,
    exportOrders,
    shareOrders,
  };
}
