'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Download,
  RefreshCw,
  Search,
  Share2,
  X,
} from 'lucide-react';
import AppShell from '@/components/app-shell/AppShell';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import FilterChips from '@/components/ui/FilterChips';
import OrderListCard from '@/components/OrderListCard';
import { useUser } from '@/context/UserContext';
import { useOrderTray } from '@/hooks/useOrderTray';
import type { UserRole } from '@/lib/authz';
import type { OrderExportFormat } from '@/lib/order-export';
import type { InitialOrderListData } from '@/lib/order-initial-data';
import {
  getOrdersTrayStatusParam,
  ORDERS_TRAY_CONFIGS,
  ORDERS_TRAY_DATE_FILTERS,
  resolveOrdersTrayDateRange,
  type OrdersTrayDatePreset,
  type OrdersTrayStatusFilterValue,
  type OrdersTrayVariant,
} from '@/lib/orders-tray';
import { consumeOrdersTrayRefresh } from '@/lib/orders-tray-refresh';
import type { OrderSummaryDTO } from '@/lib/types';

interface OrdersTrayProps {
  variant: OrdersTrayVariant;
  role: UserRole;
  username: string;
  /** Chip de sub-estado resuelto desde `?status=...` en el servidor. */
  initialStatus?: OrdersTrayStatusFilterValue;
  /** Preset de fecha resuelto desde `?date=...` en el servidor. */
  initialDatePreset?: OrdersTrayDatePreset;
  /** Vista de archivados resuelta desde `?archived=1` en el servidor. */
  initialShowArchived?: boolean;
  /** Término de búsqueda resuelto desde `?search=...` en el servidor. */
  initialSearch?: string;
  /** Primera página ya resuelta por el Server Component. */
  initialOrders?: OrderSummaryDTO[];
  initialTotal?: number | null;
  initialNextCursor?: string | null;
  /** Epoch ms de la lectura server-side; habilita el refresh silencioso. */
  initialFetchedAt?: number;
}

/**
 * Bandeja compartida por depósito y facturación: búsqueda, chips de
 * sub-estado y fecha, filtro de archivados, listado paginado por cursor,
 * acciones y confirmaciones. Las diferencias entre roles viven en
 * `ORDERS_TRAY_CONFIGS`.
 */
export default function OrdersTray({
  variant,
  role,
  username,
  initialStatus = 'all',
  initialDatePreset = 'all',
  initialShowArchived = false,
  initialSearch = '',
  initialOrders,
  initialTotal = null,
  initialNextCursor = null,
  initialFetchedAt,
}: OrdersTrayProps) {
  const config = ORDERS_TRAY_CONFIGS[variant];
  const { user } = useUser();
  const initialDateRange = resolveOrdersTrayDateRange(initialDatePreset);
  const initialData: InitialOrderListData | null = initialOrders
    ? {
        orders: initialOrders,
        total: initialTotal,
        nextCursor: initialNextCursor,
        fetchedAt: initialFetchedAt ?? 0,
        filters: {
          status: getOrdersTrayStatusParam(config, initialStatus),
          archived: initialShowArchived,
          search: initialSearch,
          startDate: initialDateRange.startDate,
          endDate: initialDateRange.endDate,
        },
      }
    : null;
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
    loadMore,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    datePreset,
    setDatePreset,
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
  } = useOrderTray(config, initialData, {
    status: initialStatus,
    datePreset: initialDatePreset,
    showArchived: initialShowArchived,
    search: initialSearch,
  });

  const pathname = usePathname();
  // En mobile el filtro de fecha vive plegado junto a los chips de estado para
  // que la primera tarjeta entre en el viewport sin scroll.
  const [dateFiltersOpen, setDateFiltersOpen] = useState(false);
  const activeDateLabel =
    ORDERS_TRAY_DATE_FILTERS.find((filter) => filter.value === datePreset)?.label ?? 'Todas';
  const trayChipVisible = pendingNotificationCount > 0;

  // El chip comparte el borde inferior con el indicador offline y el aviso del
  // service worker. El atributo permite al CSS calcular la capa de cada aviso.
  useEffect(() => {
    if (!trayChipVisible) return;

    const root = document.documentElement;
    root.dataset.trayChipVisible = 'true';

    return () => {
      delete root.dataset.trayChipVisible;
    };
  }, [trayChipVisible]);

  // Al volver de un detalle donde se guardó un cambio, el Router Cache puede
  // traer la bandeja anterior. Se pinta esa data y se refresca en segundo plano.
  useEffect(() => {
    if (consumeOrdersTrayRefresh(pathname)) refresh();
  }, [pathname, refresh]);

  const canCreateVendorOrder =
    config.variant === 'vendor' && (user?.role === 'admin' || user?.role === 'vendedor');
  const canDuplicate = canCreateVendorOrder;

  return (
    <AppShell role={role} username={username} pageTitle={config.pageTitle}>
      <div className="mb-3 flex flex-col gap-2 sm:mb-6 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-foreground sm:text-xl">
            {config.heading}
          </h2>
          <p className="hidden text-xs text-muted sm:block">{config.subtitle}</p>
        </div>
        {/* En mobile la fila de acciones es única y compacta: los textos
              secundarios se ocultan, pero cada control conserva 44 px. */}
        <div className="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5 sm:w-auto sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
          {canCreateVendorOrder && (
            <Link
              href="/orders/new"
              data-testid="orders-tray-new-order"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-action px-3 py-2 text-xs font-semibold text-action-fg shadow-elevation-1 transition-colors hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface sm:px-4"
            >
              + Nuevo Pedido
            </Link>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleArchived}
            className={`shrink-0 px-2.5 sm:px-3 ${
              showArchived ? 'bg-action-soft text-action-text' : ''
            }`}
            title={showArchived ? 'Ver pedidos activos' : 'Ver pedidos archivados'}
            aria-label={showArchived ? 'Ver Activos' : 'Ver Archivados'}
          >
            <Archive className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
            <span className="hidden sm:inline">
              {showArchived ? 'Ver Activos' : 'Ver Archivados'}
            </span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
            className="shrink-0 px-2.5 sm:px-4"
            title={refreshing ? 'Actualizando pedidos' : 'Actualizar pedidos'}
            aria-label={refreshing ? 'Actualizando pedidos' : 'Actualizar pedidos'}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-subtle ${refreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">
              {refreshing ? 'Actualizando...' : 'Actualizar'}
            </span>
          </Button>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <select
              aria-label="Formato de exportación"
              value={exportFormat}
              onChange={(event) => setExportFormat(event.target.value as OrderExportFormat)}
              disabled={exporting || sharingExport}
              className="h-9 rounded-md border border-border-strong bg-field px-2 text-xs font-medium text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-focus disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-fg sm:px-2.5"
            >
              <option value="csv">CSV</option>
              <option value="xlsx">Excel</option>
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportOrders}
              disabled={exporting || sharingExport}
              title={`Exportar pedidos a ${exportFormat === 'csv' ? 'CSV' : 'Excel'}`}
              aria-label={`Exportar pedidos a ${exportFormat === 'csv' ? 'CSV' : 'Excel'}`}
              className="shrink-0 px-2.5 sm:px-4"
            >
              {exporting ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{exporting ? 'Exportando...' : 'Exportar'}</span>
            </Button>
            {canShareExport && (
              <Button
                variant="secondary"
                size="sm"
                onClick={shareOrders}
                disabled={exporting || sharingExport}
                title={`Compartir pedidos en ${exportFormat === 'csv' ? 'CSV' : 'Excel'}`}
                aria-label={`Compartir pedidos en ${exportFormat === 'csv' ? 'CSV' : 'Excel'}`}
                data-testid="orders-tray-share-export"
                className="shrink-0 px-2.5 sm:px-4"
              >
                {sharingExport ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">
                  {sharingExport ? 'Compartiendo...' : 'Compartir'}
                </span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative mb-3 sm:mb-6">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
          aria-hidden="true"
        />
        <input
          type="text"
          placeholder={config.searchPlaceholder}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2.5 pl-10 pr-12 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30"
        />
        {searchQuery !== '' && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            aria-label="Limpiar búsqueda de pedidos"
            data-testid="orders-tray-search-clear"
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center rounded-r-md text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Chips táctiles: scrollean en horizontal sin ensanchar el documento. */}
      <div className="mb-3 space-y-2 sm:mb-6 sm:space-y-3">
        <div>
          <p className="mb-2 hidden text-[11px] font-semibold uppercase tracking-wide text-subtle sm:block">
            Estado
          </p>
          <div className="flex min-w-0 items-center gap-2">
            {/* En mobile la fecha se pliega en un chip junto a los estados. */}
            <button
              type="button"
              onClick={() => setDateFiltersOpen((open) => !open)}
              aria-expanded={dateFiltersOpen}
              aria-controls="orders-tray-date-panel"
              data-testid="orders-tray-date-toggle"
              className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-2 text-xs font-semibold transition-colors sm:hidden ${
                datePreset !== 'all'
                  ? 'border-action/60 bg-action-soft text-action-text'
                  : 'border-border bg-surface text-muted'
              }`}
            >
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              Fecha: {activeDateLabel}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${
                  dateFiltersOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </button>
            <FilterChips
              ariaLabel="Filtrar por sub-estado"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as OrdersTrayStatusFilterValue)}
              items={config.statusFilters}
              dataTestId="orders-tray-status-filters"
              itemTestIdPrefix="orders-tray-status-"
              className="min-w-0"
            />
          </div>
        </div>

        <div
          id="orders-tray-date-panel"
          className={dateFiltersOpen ? 'mt-2 sm:mt-0' : 'hidden sm:block'}
        >
          <p className="mb-2 hidden text-[11px] font-semibold uppercase tracking-wide text-subtle sm:block">
            Fecha
          </p>
          <FilterChips
            ariaLabel="Filtrar por fecha"
            value={datePreset}
            onChange={(value) => {
              setDatePreset(value as OrdersTrayDatePreset);
              // Al elegir, el panel vuelve a plegarse en mobile.
              setDateFiltersOpen(false);
            }}
            items={ORDERS_TRAY_DATE_FILTERS}
            dataTestId="orders-tray-date-filters"
            itemTestIdPrefix="orders-tray-date-"
          />
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-muted">{config.loadingLabel}</div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={searchQuery.trim() ? Search : CheckCircle2}
          title={searchQuery.trim() ? 'No encontramos pedidos' : config.emptyTitle(showArchived)}
          description={
            searchQuery.trim()
              ? `Ningún pedido coincide con “${searchQuery.trim()}”.`
              : config.emptyDescription
          }
          action={
            searchQuery.trim() ? (
              <Button variant="secondary" size="sm" onClick={() => setSearchQuery('')}>
                Limpiar búsqueda
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visibleOrders.map((order) => (
            <OrderListCard
              key={order._id}
              order={order}
              variant={config.variant}
              href={config.detailHref(order._id)}
              clickable={config.clickable}
              canDelete={user?.role === 'admin'}
              onArchive={confirmArchiveOrder}
              onDelete={confirmDeleteOrder}
              onDuplicate={canDuplicate ? confirmDuplicateOrder : undefined}
            />
          ))}
        </div>
      )}

      {/* Paginación por cursor: se anexa la página siguiente sin count ni skip */}
      {!loading && orders.length > 0 && (
        <div className="mt-8 flex flex-col items-center gap-3">
          <span
            data-loaded-orders={orders.length}
            data-rendered-orders={visibleOrders.length}
            className="text-center text-xs text-muted"
          >
            {windowStart > 0 ? (
              <>
                Mostrando {windowStart + 1}–{orders.length}
                {typeof total === 'number' ? ` de ${total}` : ''} pedidos · ventana de{' '}
                {renderedLimit} tarjetas
              </>
            ) : (
              <>
                Mostrando {orders.length}
                {typeof total === 'number' ? ` de ${total}` : ''} pedidos
              </>
            )}
          </span>
          {hasMore && (
            <Button
              variant="secondary"
              size="sm"
              onClick={loadMore}
              disabled={loadingMore || refreshing}
              className="px-5 py-2.5"
            >
              {loadingMore
                ? 'Cargando...'
                : typeof total === 'number'
                  ? `Cargar más pedidos (${Math.max(0, total - orders.length)} restantes)`
                  : 'Cargar más pedidos'}
            </Button>
          )}
        </div>
      )}

      {/* Movimientos SSE que llegaron mientras el usuario escribía o confirmaba. */}
      {trayChipVisible && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+var(--mobile-tray-chip-clearance))] z-40 flex justify-center px-4 sm:bottom-6">
          <button
            type="button"
            onClick={applyNotificationRefresh}
            data-testid="orders-tray-new-movements"
            aria-label="Actualizar la bandeja con los nuevos movimientos"
            className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-foreground px-4 py-2.5 text-xs font-semibold text-surface shadow-elevation-2 transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            <span>
              {pendingNotificationCount > 1
                ? `${pendingNotificationCount} nuevos movimientos`
                : 'Nuevos movimientos'}{' '}
              • Actualizar
            </span>
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ''}
        message={pendingConfirm?.message ?? ''}
        confirmLabel={pendingConfirm?.confirmLabel}
        variant={pendingConfirm?.variant}
        onClose={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm?.run()}
      />
    </AppShell>
  );
}
