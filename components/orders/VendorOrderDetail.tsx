'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Archive,
  Building2,
  ClipboardList,
  Clock,
  Copy,
  Package,
  Pencil,
} from 'lucide-react';
import AppShell from '@/components/app-shell/AppShell';
import StatusBadge from '@/components/StatusBadge';
import CommentsPanel from '@/components/CommentsPanel';
import ConfirmDialog from '@/components/ConfirmDialog';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import { useToast } from '@/context/ToastContext';
import OrderDetailSkeleton from '@/components/orders/OrderDetailSkeleton';
import OrderLineFilters from '@/components/orders/OrderLineFilters';
import OrderPrintLink from '@/components/orders/OrderPrintLink';
import OrderShareButtons from '@/components/orders/OrderShareButtons';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
} from '@/components/ui/Table';
import { api } from '@/lib/api-client';
import type { UserRole } from '@/lib/authz';
import { DASHBOARD_TIME_ZONE } from '@/lib/dashboard-time';
import { formatInvoiceType, formatPaymentCondition } from '@/lib/order-commercial';
import {
  countOrderLineFilters,
  filterOrderLines,
  type OrderLineFilter,
} from '@/lib/order-line-filter';
import {
  getOrderLineStatus,
  orderLineHasShortage,
  type OrderLineStatusTone,
} from '@/lib/order-line-status';
import { useOrderDetail } from '@/hooks/useOrderDetail';
import { getOrdersTrayBackHref } from '@/lib/orders-tray';
import { consumeOrdersTrayRefresh, markOrdersTrayForRefresh } from '@/lib/orders-tray-refresh';
import type { OrderDTO, OrderItemDTO, OrderMutationResponse } from '@/lib/types';

const money = (value: number) => `$${value.toFixed(2)}`;

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: DASHBOARD_TIME_ZONE,
});

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME_FORMATTER.format(date);
};

const LINE_STATUS_TONE_STYLES: Record<OrderLineStatusTone, string> = {
  neutral: 'border-border bg-surface-muted text-subtle',
  danger: 'border-status-blocked-border bg-status-blocked-soft text-status-blocked',
  warning: 'border-status-draft-border bg-status-draft-soft text-status-draft',
  success: 'border-status-delivered-border bg-status-delivered-soft text-status-delivered',
};

function ItemPendingBadge({
  item,
  orderStatus,
}: {
  item: OrderItemDTO;
  orderStatus: OrderDTO['status'];
}) {
  const status = getOrderLineStatus(item, orderStatus);
  const pendingReason = item.pendingReason?.trim();

  if (status.kind === 'unverified') {
    return <span className="text-xs text-subtle">{status.label}</span>;
  }

  return (
    <div data-testid="vendor-line-status" data-line-status={status.kind}>
      <span
        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${LINE_STATUS_TONE_STYLES[status.tone]}`}
      >
        {status.label}
      </span>
      {pendingReason && <span className="mt-1 block text-[11px] text-muted">{pendingReason}</span>}
    </div>
  );
}

/**
 * Detalle del pedido para "Mis pedidos": muestra cliente, datos comerciales,
 * líneas y comentarios. El vendedor puede comentar, filtrar líneas largas y
 * archivar/desarchivar el pedido sin pasar por la bandeja.
 */
export default function VendorOrderDetail({
  orderId,
  role,
  username,
  initialOrder,
  initialError,
  initialFetchedAt,
}: {
  orderId: string;
  role: UserRole;
  username: string;
  initialOrder: OrderDTO | null;
  initialError: string | null;
  initialFetchedAt?: number;
}) {
  const { order, setOrder, loading, error, refresh } = useOrderDetail(orderId, {
    initialOrder,
    initialError,
    initialFetchedAt,
  });
  const router = useRouter();
  const backHref = getOrdersTrayBackHref('/orders');
  const { showToast } = useToast();
  const [newComment, setNewComment] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  const [lineFilter, setLineFilter] = useState<OrderLineFilter>('all');
  const [lineSearch, setLineSearch] = useState('');
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  // Al volver de la edición, el Router Cache puede tener el RSC anterior del
  // detalle. El marcador fuerza una revalidación silenciosa con la API.
  useEffect(() => {
    if (consumeOrdersTrayRefresh(`/orders/${orderId}`)) void refresh();
  }, [orderId, refresh]);

  /**
   * Guardar un comentario no cambia la etapa ni navega: persiste el texto y
   * actualiza la versión local para que el próximo guardado no dé 409.
   */
  const handleSaveComment = async () => {
    if (!order || savingComment) return;

    const commentText = newComment.trim();
    if (!commentText) return;

    setSavingComment(true);

    try {
      const data = await api.put<OrderMutationResponse>(`/api/orders/${orderId}`, {
        version: order.version ?? 0,
        comment: commentText,
      });

      setOrder((prev) =>
        prev
          ? {
              ...prev,
              version: data.order.version ?? prev.version,
              comments: data.order.comments ?? [
                ...(prev.comments ?? []),
                {
                  text: commentText,
                  author: prev.createdBy,
                  role: 'vendedor',
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );

      setNewComment('');
      showToast('¡Comentario agregado exitosamente!', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Error al guardar el comentario', 'error');
    } finally {
      setSavingComment(false);
    }
  };

  /**
   * Alterna el archivado desde el detalle. El PUT devuelve la versión nueva,
   * que se adopta localmente para que un comentario posterior no dé 409. La
   * bandeja de "Mis pedidos" se revalida al volver mediante el marcador.
   */
  const handleToggleArchive = async () => {
    if (!order) return;

    const nextArchived = !order.archived;

    try {
      const data = await api.put<OrderMutationResponse>(`/api/orders/${orderId}`, {
        version: order.version ?? 0,
        archived: nextArchived,
      });

      setOrder((prev) =>
        prev
          ? {
              ...prev,
              archived: data.order.archived ?? nextArchived,
              version: data.order.version ?? prev.version,
            }
          : prev,
      );
      markOrdersTrayForRefresh('/orders');
      showToast(
        nextArchived ? 'Pedido archivado exitosamente' : 'Pedido desarchivado exitosamente',
        'success',
      );
    } catch (err: unknown) {
      showToast(
        err instanceof Error
          ? err.message
          : nextArchived
            ? 'Error al archivar el pedido'
            : 'Error al desarchivar el pedido',
        'error',
      );
    }
  };

  if (loading) {
    return <OrderDetailSkeleton variant="vendor" />;
  }

  if (error || !order) {
    return (
      <AppShell
        role={role}
        username={username}
        pageTitle="Pedido"
        backLabel="Volver"
        backHref={backHref}
      >
        <EmptyState
          icon={ClipboardList}
          title="No pudimos abrir el pedido"
          description={error ?? 'Pedido no encontrado.'}
        />
      </AppShell>
    );
  }

  const clientName = order.clientName ?? order.clientId?.name ?? 'Cliente desconocido';
  const clientCode = order.clientCode ?? order.clientId?.code;

  // Las reglas de pendiente/diferencia son las mismas que usa el badge, para
  // que el resumen, los chips y cada línea nunca se contradigan.
  const lineFilterPredicates = {
    isPending: (item: OrderItemDTO) => {
      const { kind } = getOrderLineStatus(item, order.status);
      return kind === 'unverified' || kind === 'missing';
    },
    hasDifference: (item: OrderItemDTO) => orderLineHasShortage(item, order.status),
  };
  const lineFilterCounts = countOrderLineFilters(order.items, lineFilterPredicates);
  const visibleItems = filterOrderLines(
    order.items,
    { filter: lineFilter, query: lineSearch },
    lineFilterPredicates,
    (item) => item._id,
  );
  const showLineFilters = order.items.length > 5;
  // Si el atajo del resumen activa "faltantes" en un pedido corto, la barra
  // aparece igual para poder volver a "Todas" sin quedar atrapado en el filtro.
  const showLineFilterBar = showLineFilters || lineFilter !== 'all' || lineSearch.trim() !== '';
  const shortageCount = lineFilterCounts.difference;
  const showShortageSummary = order.status === 'paralizado' || shortageCount > 0;
  const shortageLabel =
    shortageCount === 1 ? '1 línea con faltante' : `${shortageCount} líneas con faltante`;

  return (
    <AppShell
      role={role}
      username={username}
      pageTitle={`Pedido #${order._id.slice(-6)}`}
      pageDescription={clientName}
      backLabel="Volver"
      backHref={backHref}
    >
      <div className="space-y-4 sm:space-y-6">
        <Card className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-action-soft text-action-text">
                <Building2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-foreground">{clientName}</h2>
                <p className="mt-0.5 font-mono text-xs text-muted">Código: {clientCode ?? '—'}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">
              Dirección: {order.clientId?.address || 'N/A'}{' '}
              {order.clientId?.localidad
                ? `(${order.clientId.localidad}${
                    order.clientId.province ? `, ${order.clientId.province}` : ''
                  })`
                : order.clientId?.province
                  ? `(${order.clientId.province})`
                  : ''}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <Clock className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
              {formatDate(order.createdAt)}
            </p>
          </div>

          <div className="flex w-full flex-col items-start gap-2 md:w-auto md:items-end">
            <StatusBadge variant="vendor" status={order.status} />
            {order.archived && (
              <p className="flex items-center gap-1 text-[11px] font-medium text-muted">
                <Archive className="h-3.5 w-3.5" aria-hidden="true" /> Pedido archivado
              </p>
            )}
          </div>
        </Card>

        {/* Continuidad del trabajo: el próximo cliente se encadena en un
            toque y las acciones de handoff quedan agrupadas y visibles. */}
        <div
          data-testid="vendor-order-continuity-actions"
          className="rounded-lg border border-border bg-surface p-3"
        >
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
            Continuar el trabajo
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => router.push('/orders/new')}
              data-testid="vendor-order-new-order"
            >
              + Nuevo pedido
            </Button>
            {order.status === 'borrador' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push(`/orders/${orderId}/edit`)}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" /> Editar borrador
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push(`/orders/new?fromOrder=${orderId}`)}
            >
              <Copy className="h-4 w-4" aria-hidden="true" /> Repetir pedido
            </Button>
            <OrderShareButtons order={order} hideLabelOnMobile />
            <OrderPrintLink href={`/orders/${orderId}/print`} hideLabelOnMobile />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setArchiveDialogOpen(true)}
              data-testid="vendor-order-archive"
              title={order.archived ? 'Desarchivar pedido' : 'Archivar pedido'}
            >
              <Archive className="h-4 w-4" aria-hidden="true" />
              {order.archived ? 'Desarchivar' : 'Archivar'}
            </Button>
          </div>
        </div>

        <Card className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
              Vendedor
            </span>
            <p className="mt-1 text-sm font-semibold text-foreground">{order.createdBy}</p>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
              Tipo de factura
            </span>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatInvoiceType(order.invoiceType)}
            </p>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
              Condición de pago
            </span>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatPaymentCondition(order.paymentCondition, order.paymentConditionDetail)}
            </p>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
              Ítems
            </span>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {order.items.length} productos
            </p>
          </div>
        </Card>

        {showShortageSummary && (
          <div
            data-testid="vendor-order-shortage-summary"
            className="flex flex-col gap-3 rounded-lg border border-status-draft-border bg-status-draft-soft p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-status-draft-soft text-status-draft">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-status-draft">
                  {order.status === 'paralizado'
                    ? 'Pedido paralizado'
                    : 'Hay faltantes en el pedido'}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {shortageCount > 0
                    ? `${shortageLabel}. Revisá el motivo registrado por depósito en cada línea.`
                    : 'El pedido está retenido en depósito, pero no hay líneas con faltante registradas.'}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLineFilter('difference')}
              data-testid="vendor-order-shortage-filter"
              className="shrink-0"
            >
              Ver solo faltantes
            </Button>
          </div>
        )}

        <Card className="space-y-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Package className="h-4 w-4 text-action-text" aria-hidden="true" /> Detalle de ítems
          </h3>

          {showLineFilterBar && (
            <OrderLineFilters
              counts={lineFilterCounts}
              filter={lineFilter}
              onFilterChange={setLineFilter}
              query={lineSearch}
              onQueryChange={setLineSearch}
            />
          )}

          <div className="space-y-3 sm:hidden">
            {visibleItems.map((item) => (
              <div
                key={item._id}
                data-testid="vendor-order-item-card"
                className="rounded-lg border border-border bg-surface-muted p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-mono text-xs text-muted">
                      {item.productCode ?? item.productId?.code ?? '—'}
                    </span>
                    <h4 className="mt-0.5 text-sm font-medium text-foreground">
                      {item.productName ?? item.productId?.name ?? 'Producto'}
                    </h4>
                    <span className="text-[11px] text-action-text">
                      {item.brandName ?? item.productId?.brandId?.name ?? 'Sin marca'}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-foreground">
                    {money(item.lineTotal)}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
                  <div>
                    <span className="block text-[11px] font-semibold uppercase text-subtle">
                      Solicitado
                    </span>
                    <span className="font-semibold text-foreground">{item.requestedQuantity}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] font-semibold uppercase text-subtle">
                      Verificado
                    </span>
                    <span className="font-semibold text-foreground">{item.verifiedQuantity}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] font-semibold uppercase text-subtle">
                      Desc.
                    </span>
                    <span className="font-semibold text-foreground">{item.itemDiscount || 0}%</span>
                  </div>
                </div>

                <div className="mt-3 border-t border-border pt-3">
                  <ItemPendingBadge item={item} orderStatus={order.status} />
                </div>
              </div>
            ))}
          </div>

          {order.items.length === 0 && (
            <div className="rounded-lg border border-border bg-surface-muted px-4 py-8 text-center text-xs text-muted">
              Este pedido no tiene productos.
            </div>
          )}

          {order.items.length > 0 && visibleItems.length === 0 && (
            <div
              data-testid="vendor-order-lines-empty"
              className="rounded-lg border border-border bg-surface-muted px-4 py-8 text-center text-xs text-muted"
            >
              No hay líneas que coincidan con el filtro o la búsqueda.
            </div>
          )}

          {visibleItems.length > 0 && (
            <div className="hidden sm:block">
              <Table dense>
                <TableHead>
                  <TableHeaderRow>
                    <TableHeaderCell>Código</TableHeaderCell>
                    <TableHeaderCell>Producto</TableHeaderCell>
                    <TableHeaderCell align="center">Solicitado</TableHeaderCell>
                    <TableHeaderCell align="center">Verificado</TableHeaderCell>
                    <TableHeaderCell align="right">Precio Unit.</TableHeaderCell>
                    <TableHeaderCell align="center">Desc. (%)</TableHeaderCell>
                    <TableHeaderCell align="right">Total Línea</TableHeaderCell>
                    <TableHeaderCell>Estado</TableHeaderCell>
                  </TableHeaderRow>
                </TableHead>
                <TableBody>
                  {visibleItems.map((item) => (
                    <TableRow key={item._id}>
                      <TableCell className="font-mono text-xs text-muted">
                        {item.productCode ?? item.productId?.code ?? '—'}
                      </TableCell>
                      <TableCell className="font-medium text-foreground">
                        {item.productName ?? item.productId?.name ?? 'Producto'}
                        <span className="block text-[11px] text-action-text">
                          {item.brandName ?? item.productId?.brandId?.name ?? 'Sin marca'}
                        </span>
                      </TableCell>
                      <TableCell align="center" className="font-semibold">
                        {item.requestedQuantity}
                      </TableCell>
                      <TableCell align="center" className="font-semibold">
                        {item.verifiedQuantity}
                      </TableCell>
                      <TableCell align="right" className="font-mono">
                        {money(item.unitPrice)}
                      </TableCell>
                      <TableCell align="center">{item.itemDiscount || 0}%</TableCell>
                      <TableCell align="right" className="font-semibold">
                        {money(item.lineTotal)}
                      </TableCell>
                      <TableCell>
                        <ItemPendingBadge item={item} orderStatus={order.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="ml-auto max-w-sm space-y-2 rounded-lg border border-border bg-surface-muted p-4 text-sm">
            <div className="flex justify-between text-muted">
              <span>Subtotal:</span>
              <span className="tabular-nums">{money(order.subtotal)}</span>
            </div>
            <div className="flex justify-between text-muted">
              <span>Descuentos totales:</span>
              <span className="tabular-nums text-status-delivered">
                -{money(order.totalDiscount)}
              </span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-foreground">
              <span>Total:</span>
              <span className="tabular-nums">{money(order.finalTotal)}</span>
            </div>
          </div>
        </Card>

        <CommentsPanel
          comments={order.comments}
          value={newComment}
          onChange={setNewComment}
          variant="vendor"
          onSubmit={handleSaveComment}
          submitting={savingComment}
        />

        <ConfirmDialog
          open={archiveDialogOpen}
          title={order.archived ? 'Desarchivar pedido' : 'Archivar pedido'}
          message={
            order.archived
              ? '¿Estás seguro de desarchivar este pedido? Volverá a la bandeja de pedidos activos.'
              : '¿Estás seguro de archivar este pedido? Podrás encontrarlo en la bandeja de archivados.'
          }
          confirmLabel={order.archived ? 'Desarchivar' : 'Archivar'}
          variant="primary"
          onConfirm={handleToggleArchive}
          onClose={() => setArchiveDialogOpen(false)}
        />
      </div>
    </AppShell>
  );
}
