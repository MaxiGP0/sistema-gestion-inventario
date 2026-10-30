'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText,
  CheckCircle2,
  Building2,
  Package,
  Copy,
  Check,
  ClipboardCheck,
  AlertTriangle,
  Undo2,
  CheckCheck,
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import AppShell from '@/components/app-shell/AppShell';
import CommentsPanel from '@/components/CommentsPanel';
import ConfirmDialog from '@/components/ConfirmDialog';
import StatusBadge from '@/components/StatusBadge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import OrderDetailSkeleton from '@/components/orders/OrderDetailSkeleton';
import OrderLineFilters from '@/components/orders/OrderLineFilters';
import OrderPrintLink from '@/components/orders/OrderPrintLink';
import OrderShareButtons from '@/components/orders/OrderShareButtons';
import OrderStaleVersionBanner from '@/components/orders/OrderStaleVersionBanner';
import { useMobileKeyboardFocus } from '@/hooks/useVisualViewport';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
} from '@/components/ui/Table';
import {
  billingLineQuantity as lineQuantity,
  billingPendingDetail as pendingDetailOf,
  formatBillingItemLine,
  MISSING_LINE_LABEL,
} from '@/lib/billing-order-format';
import {
  formatBrandDiscount,
  formatDiscountRange,
  summarizeBillingDiscounts,
} from '@/lib/billing-discounts';
import {
  countOrderLineFilters,
  filterOrderLines,
  type OrderLineFilter,
} from '@/lib/order-line-filter';
import {
  POST_CONTROL_LABELS,
  POST_CONTROL_VALUES,
  countUncontrolledPostItems,
  isPostControlPending,
  resolvePostControl,
  type PostControl,
} from '@/lib/order-post-control';
import {
  PostControlWriteQueue,
  type PostControlSyncUpdate,
  type PostControlWireUpdate,
} from '@/lib/post-control-queue';
import {
  buildMarkAllOkUpdates,
  buildRestorePostControlUpdates,
  snapshotPostControls,
  type PostControlSnapshot,
  type PostControlUpdate,
} from '@/lib/post-control-bulk';
import { formatInvoiceType, formatPaymentCondition } from '@/lib/order-commercial';
import { getOrdersTrayBackHref } from '@/lib/orders-tray';
import { markOrdersTrayForRefresh } from '@/lib/orders-tray-refresh';
import { useOrderDetail } from '@/hooks/useOrderDetail';
import { orderVersion } from '@/lib/order-live-sync';
import { api } from '@/lib/api-client';
import type { UserRole } from '@/lib/authz';
import type { OrderDTO, OrderMutationResponse, OrderPostControlResponse } from '@/lib/types';

/** Pedido completo: DTO compartido con la API. */
type Order = OrderDTO;

function PostControlSelector({
  value,
  disabled,
  saving = false,
  onChange,
}: {
  value?: PostControl;
  disabled: boolean;
  saving?: boolean;
  onChange: (next: PostControl) => void;
}) {
  const current = value ?? 'pendiente';

  return (
    <div className="inline-flex items-center gap-1.5">
      <div
        className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface"
        role="group"
        aria-label="Control post-factura de la línea"
        aria-busy={saving || undefined}
      >
        {POST_CONTROL_VALUES.map((option) => {
          const active = current === option;
          const activeClass =
            option === 'ok'
              ? 'bg-status-delivered text-white'
              : option === 'diferencia'
                ? 'bg-status-draft text-white'
                : 'bg-disabled text-foreground';

          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              disabled={disabled}
              aria-pressed={active}
              className={`px-3 py-2 text-xs font-semibold transition max-md:min-h-11 max-md:min-w-11 disabled:cursor-not-allowed disabled:opacity-50 ${
                active ? activeClass : 'text-muted hover:bg-surface-muted'
              }`}
            >
              {POST_CONTROL_LABELS[option]}
            </button>
          );
        })}
      </div>
      {saving && (
        <span
          role="status"
          aria-label="Guardando control post-factura"
          data-testid="post-control-saving"
          className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-action"
        />
      )}
    </div>
  );
}

interface BillingOrderClientProps {
  orderId: string;
  role: UserRole;
  username: string;
  /** Pedido resuelto en el servidor; evita el spinner y el GET de montaje. */
  initialOrder: OrderDTO | null;
  initialError: string | null;
  initialFetchedAt?: number;
}

export default function BillingOrderClient({
  orderId: id,
  role,
  username,
  initialOrder,
  initialError,
  initialFetchedAt,
}: BillingOrderClientProps) {
  const backHref = getOrdersTrayBackHref('/billing/orders');
  const [submitting, setSubmitting] = useState(false);
  const [savingComment, setSavingComment] = useState(false);
  const [savingPostControlIds, setSavingPostControlIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [bulkSaving, setBulkSaving] = useState(false);
  const [undoControls, setUndoControls] = useState<PostControlSnapshot | null>(null);
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [lineFilter, setLineFilter] = useState<OrderLineFilter>('all');
  const [lineSearch, setLineSearch] = useState('');
  const [pinnedItemKey, setPinnedItemKey] = useState<string | null>(null);
  const [isNavigating, startTransition] = useTransition();
  const inputFocused = useMobileKeyboardFocus();
  const { showToast } = useToast();
  const router = useRouter();
  const versionRef = useRef(initialOrder?.version ?? 0);
  const postControlQueueRef = useRef<PostControlWriteQueue | null>(null);
  const hasLocalChangesRef = useRef(false);

  const { order, setOrder, loading, error, pendingOrder, applyPendingOrder } =
    useOrderDetail<Order>(id, {
      initialOrder,
      initialError,
      initialFetchedAt,
      hasLocalChanges: () =>
        hasLocalChangesRef.current || (postControlQueueRef.current?.size ?? 0) > 0,
      onRemoteOrderApplied: (remote, previous) => {
        if (!previous || orderVersion(remote) <= orderVersion(previous)) return;

        // La versión aplicada es la base del próximo PATCH: se actualiza antes
        // de que la cola post-factura vuelva a leerla.
        versionRef.current = orderVersion(remote);
        showToast('Pedido actualizado', 'success');
      },
      onRemoteMetadataMerged: (merged, previous) => {
        // Un comentario remoto avanzó la versión sin tocar líneas: el próximo
        // PATCH debe usar la versión vigente para no responder 409.
        if (!previous || orderVersion(merged) <= orderVersion(previous)) return;
        versionRef.current = orderVersion(merged);
      },
    });

  // Se muestran todas las líneas, incluidas las que quedaron en 0 por no
  // haber sido controladas en depósito: son faltantes y deben verse.
  const billingItems = order?.items ?? [];
  const discountSummary = summarizeBillingDiscounts(billingItems);
  const missingItems = billingItems.filter((item) => item.lineTotal === 0);
  const pendingControlCount = countUncontrolledPostItems(billingItems);
  const hasPendingPostControlWrites = savingPostControlIds.size > 0;
  const canControlLines =
    order?.status === 'facturacion' || order?.status === 'control_post_factura';
  const currentVersion = orderVersion(order);
  const pendingVersion = orderVersion(pendingOrder);
  const showStaleVersionBanner = Boolean(pendingOrder) && pendingVersion > currentVersion;

  /**
   * Conserva la tarjeta activa mientras el operario la toca. El pin se libera
   * al cambiar de chip, buscar o tocar otra línea; así el filtro sigue siendo
   * predecible pero no "roba" la tarjeta en medio de los toques.
   */
  const pinActiveLine = useCallback(
    (itemId: string) => {
      setPinnedItemKey(lineFilter === 'all' ? null : itemId);
    },
    [lineFilter],
  );

  const handleLineFilterChange = useCallback((next: OrderLineFilter) => {
    setPinnedItemKey(null);
    setLineFilter(next);
  }, []);

  const handleLineSearchChange = useCallback((next: string) => {
    setPinnedItemKey(null);
    setLineSearch(next);
  }, []);

  // Cualquier escritura/edición en curso desactiva la aplicación automática de
  // una versión remota. Se mantiene en un ref para que el SSE lea el valor más
  // reciente sin reinstalar la suscripción.
  useEffect(() => {
    hasLocalChangesRef.current =
      hasPendingPostControlWrites ||
      savingComment ||
      submitting ||
      bulkSaving ||
      Boolean(newComment.trim()) ||
      (postControlQueueRef.current?.size ?? 0) > 0;
  }, [bulkSaving, hasPendingPostControlWrites, newComment, savingComment, submitting]);

  const lineFilterPredicates = {
    isPending: (item: OrderDTO['items'][number]) => isPostControlPending(item),
    hasDifference: (item: OrderDTO['items'][number]) =>
      item.lineTotal === 0 ||
      Boolean(item.pendingReason?.trim()) ||
      resolvePostControl(item.postControl) === 'diferencia',
  };
  const lineFilterCounts = countOrderLineFilters(billingItems, lineFilterPredicates);
  const showLineFilters = billingItems.length > 5;
  const pinnedLineKeys = pinnedItemKey ? new Set([pinnedItemKey]) : undefined;
  const visibleBillingItems = showLineFilters
    ? filterOrderLines(
        billingItems,
        { filter: lineFilter, query: lineSearch, pinnedKeys: pinnedLineKeys },
        lineFilterPredicates,
        (item) => item._id,
      )
    : billingItems;

  // La cola y los handlers usan refs/estado estable: la versión se lee al
  // iniciar cada lote, nunca de un render viejo.
  useEffect(() => {
    versionRef.current = order?.version ?? 0;
  }, [order?.version]);

  // Se mezcla solo el control y la versión para conservar los datos poblados
  // del GET (cliente y, en pedidos históricos, producto). El PATCH devuelve un
  // payload liviano: no vuelve a poblar colecciones ajenas.
  const mergePostControlResponse = useCallback(
    (data: OrderPostControlResponse) => {
      const nextVersion = data.order.version ?? versionRef.current;
      versionRef.current = nextVersion;

      const updatedControlById = new Map<string, PostControl>(
        data.order.items.map((item) => [item._id, item.postControl ?? 'pendiente']),
      );

      setOrder((prev) =>
        prev
          ? {
              ...prev,
              version: nextVersion,
              items: prev.items.map((item) => ({
                ...item,
                postControl: updatedControlById.get(item._id) ?? item.postControl,
              })),
            }
          : prev,
      );
    },
    [setOrder],
  );

  const handlePostControlSavingChange = useCallback(
    (itemIds: readonly string[], saving: boolean) => {
      setSavingPostControlIds((prev) => {
        const changed = itemIds.some((itemId) => prev.has(itemId) !== saving);
        if (!changed) return prev;

        const next = new Set(prev);
        itemIds.forEach((itemId) => {
          if (saving) next.add(itemId);
          else next.delete(itemId);
        });
        return next;
      });
    },
    [],
  );

  const handlePostControlQueueError = useCallback(
    (failed: readonly PostControlSyncUpdate[], error: unknown) => {
      const previousById = new Map(failed.map((change) => [change.itemId, change.previous]));

      setOrder((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                previousById.has(item._id)
                  ? { ...item, postControl: previousById.get(item._id) }
                  : item,
              ),
            }
          : prev,
      );

      showToast(
        error instanceof Error ? error.message : 'No se pudo guardar el control post-factura.',
        'error',
      );
    },
    [setOrder, showToast],
  );

  const sendPostControlBatch = useCallback(
    async (updates: PostControlWireUpdate[], version: number) => {
      const data = await api.patch<OrderPostControlResponse>(`/api/orders/${id}/post-control`, {
        version,
        items: updates,
      });

      const nextVersion = data.order.version ?? version + 1;
      versionRef.current = nextVersion;
      setOrder((prev) => (prev ? { ...prev, version: nextVersion } : prev));
      // Un cambio puntual invalida el "Deshacer" masivo: revertir también
      // desharía esta edición manual.
      setUndoControls(null);
    },
    [id, setOrder],
  );

  useEffect(() => {
    const queue = new PostControlWriteQueue({
      getVersion: () => versionRef.current,
      send: sendPostControlBatch,
      onSavingChange: handlePostControlSavingChange,
      onError: handlePostControlQueueError,
    });
    postControlQueueRef.current = queue;

    return () => {
      queue.dispose();
      postControlQueueRef.current = null;
    };
  }, [handlePostControlQueueError, handlePostControlSavingChange, sendPostControlBatch]);

  const handleUpdateStatus = async (newStatus: string) => {
    if (!order || submitting || savingComment || isNavigating || hasPendingPostControlWrites)
      return;

    // Doble barrera además del botón deshabilitado: el servidor también lo
    // rechaza, pero acá evitamos un viaje inútil y explicamos el motivo.
    if (newStatus === 'entregado' && pendingControlCount > 0) {
      showToast(
        `Faltan ${pendingControlCount} ${pendingControlCount === 1 ? 'línea' : 'líneas'} por controlar.`,
        'error',
      );
      return;
    }

    setSubmitting(true);

    try {
      const data = await api.put<OrderMutationResponse>(`/api/orders/${id}`, {
        version: versionRef.current,
        status: newStatus,
      });

      const nextVersion = data.order.version ?? versionRef.current;
      versionRef.current = nextVersion;
      setOrder((prev) =>
        prev
          ? {
              ...prev,
              status: data.order.status ?? prev.status,
              version: nextVersion,
            }
          : prev,
      );

      showToast(`¡Estado actualizado a: ${newStatus.toUpperCase()}!`, 'success');

      // El listado destino puede venir de la caché del Router con el estado
      // anterior al PUT. El marcador lo refresca en segundo plano al montar.
      markOrdersTrayForRefresh('/billing/orders');
      startTransition(() => router.push('/billing/orders'));
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Guardar un comentario no cierra la etapa ni navega: sólo persiste el texto
   * y actualiza la versión local para que el siguiente guardado no dé 409.
   */
  const handleSaveComment = async () => {
    if (!order || savingComment || submitting || bulkSaving || hasPendingPostControlWrites) return;

    const commentText = newComment.trim();
    if (!commentText) return;

    setSavingComment(true);

    try {
      const data = await api.put<OrderMutationResponse>(`/api/orders/${id}`, {
        version: versionRef.current,
        comment: commentText,
      });

      const nextVersion = data.order.version ?? versionRef.current;
      versionRef.current = nextVersion;

      setOrder((prev) =>
        prev
          ? {
              ...prev,
              version: nextVersion,
              comments: data.order.comments ?? [
                ...(prev.comments ?? []),
                {
                  text: commentText,
                  author: 'Facturación',
                  role: 'billing',
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );

      setNewComment('');
      showToast('¡Comentario agregado exitosamente!', 'success');
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setSavingComment(false);
    }
  };

  /**
   * El toque se refleja al instante en la línea. La escritura viaja en una cola
   * serializada que usa la última versión recibida: tocar varias líneas rápido
   * no bloquea la UI ni produce 409 falsos.
   */
  const handleSetPostControl = (itemId: string, postControl: PostControl) => {
    if (!order || bulkSaving || savingComment) return;

    pinActiveLine(itemId);

    const item = order.items.find((candidate) => candidate._id === itemId);
    if (!item) return;

    const previous = resolvePostControl(item.postControl);
    if (previous === postControl) return;

    setOrder((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((candidate) =>
              candidate._id === itemId ? { ...candidate, postControl } : candidate,
            ),
          }
        : prev,
    );
    setUndoControls(null);
    hasLocalChangesRef.current = true;
    postControlQueueRef.current?.enqueue({ itemId, postControl, previous });
  };

  /** El operario acepta descartar su control local y seguir con el servidor. */
  const handleLoadLatestVersion = useCallback(() => {
    hasLocalChangesRef.current = false;
    applyPendingOrder();
  }, [applyPendingOrder]);

  const applyBulkPostControl = async (updates: PostControlUpdate[], message: string) => {
    if (
      !order ||
      updates.length === 0 ||
      bulkSaving ||
      savingComment ||
      hasPendingPostControlWrites
    )
      return false;

    setBulkSaving(true);
    try {
      const data = await api.patch<OrderPostControlResponse>(`/api/orders/${id}/post-control`, {
        version: versionRef.current,
        items: updates,
      });

      mergePostControlResponse(data);
      showToast(message, 'success');
      return true;
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
      return false;
    } finally {
      setBulkSaving(false);
    }
  };

  const handleMarkAllOk = async () => {
    const updates = buildMarkAllOkUpdates(billingItems);
    if (updates.length === 0) return;

    const previous = snapshotPostControls(billingItems);
    const saved = await applyBulkPostControl(
      updates,
      updates.length === 1
        ? 'Se marcó 1 línea como OK.'
        : `Se marcaron ${updates.length} líneas como OK.`,
    );

    if (saved) setUndoControls(previous);
  };

  const handleUndoPostControl = async () => {
    if (!undoControls) return;

    const updates = buildRestorePostControlUpdates(billingItems, undoControls);
    if (updates.length === 0) {
      setUndoControls(null);
      return;
    }

    const saved = await applyBulkPostControl(updates, 'Se deshizo el control masivo.');
    if (saved) setUndoControls(null);
  };

  const canMarkInvoiced = order?.status === 'facturacion';
  const showFinalAction =
    order?.status === 'facturacion' || order?.status === 'control_post_factura';

  // Acción final contextual de la barra fija de mobile: el cierre del pedido.
  const finalActionDisabled =
    submitting ||
    savingComment ||
    isNavigating ||
    pendingControlCount > 0 ||
    hasPendingPostControlWrites;

  const handleCopyStructuredData = () => {
    if (!order) return;

    let text = `--- DATOS ESTRUCTURADOS PARA FACTURACIÓN ---\n`;
    text += `Cliente: ${order.clientName ?? order.clientId?.name} (Código: ${order.clientCode ?? order.clientId?.code})\n`;
    text += `Dirección: ${order.clientId?.address || 'N/A'} - ${order.clientId?.localidad || ''}\n`;
    text += `Vendedor: ${order.createdBy}\n`;
    text += `Tipo de factura: ${formatInvoiceType(order.invoiceType)}\n`;
    text += `Condición de pago: ${formatPaymentCondition(order.paymentCondition, order.paymentConditionDetail)}\n`;
    text += `Descuentos Aplicados (congelados por línea): ${formatDiscountRange(discountSummary)} | Efectivo: ${discountSummary.effectiveDiscountPercentage.toFixed(1)}%\n`;
    discountSummary.brands.forEach((brand) => {
      text += `  ${brand.brandName}: ${formatBrandDiscount(brand)}\n`;
    });
    text += `\n`;
    text += `Ítems (incluye líneas sin controlar/faltantes):\n`;

    billingItems.forEach((item, idx) => {
      text += `${formatBillingItemLine(item, idx)}\n`;
    });

    text += `\nSubtotal: $${order.subtotal.toFixed(2)}\n`;
    text += `Descuentos Totales: -$${order.totalDiscount.toFixed(2)}\n`;
    text += `TOTAL FINAL: $${order.finalTotal.toFixed(2)}\n`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return <OrderDetailSkeleton variant="billing" />;
  }

  if (!order) {
    return (
      <AppShell
        role={role}
        username={username}
        pageTitle="Datos Estructurados"
        backLabel="Volver"
        backHref={backHref}
      >
        <EmptyState
          icon={FileText}
          title="No pudimos abrir el pedido"
          description={error ?? 'Pedido no encontrado'}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      role={role}
      username={username}
      pageTitle="Datos Estructurados"
      pageDescription={`Pedido #${order._id.slice(-6)} · ${order.clientName ?? order.clientId?.name ?? ''}`}
      backLabel="Volver"
      backHref={backHref}
      bottomClearance="extra"
      maxWidth="7xl"
    >
      <div className="space-y-4 sm:space-y-6">
        {showStaleVersionBanner && (
          <OrderStaleVersionBanner
            currentVersion={currentVersion}
            latestVersion={pendingVersion}
            onLoadLatest={handleLoadLatestVersion}
          />
        )}

        {/* Info del cliente y acciones de handoff */}
        <Card className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-action-soft text-action-text">
                <Building2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-foreground">
                  {order.clientName ?? order.clientId?.name}
                </h2>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  Código: {order.clientCode ?? order.clientId?.code}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">
              Dirección: {order.clientId?.address || 'N/A'}{' '}
              {order.clientId?.localidad
                ? `(${order.clientId.localidad}${order.clientId?.province ? `, ${order.clientId.province}` : ''})`
                : order.clientId?.province
                  ? `(${order.clientId.province})`
                  : ''}
            </p>
            <p className="mt-1 text-xs text-muted">
              Vendedor: <span className="font-semibold text-foreground">{order.createdBy}</span>
            </p>
            <p className="mt-1 text-xs text-muted">
              Comercial:{' '}
              <span className="font-semibold text-foreground">
                {formatInvoiceType(order.invoiceType)} ·{' '}
                {formatPaymentCondition(order.paymentCondition, order.paymentConditionDetail)}
              </span>
            </p>
          </div>
          <div className="flex w-full flex-col items-start gap-3 md:w-auto md:items-end">
            <StatusBadge variant="billing" status={order.status} />
            <div className="flex flex-wrap items-center gap-2">
              <OrderShareButtons order={order} hideLabelOnMobile />
              <OrderPrintLink href={`/billing/orders/${id}/print`} hideLabelOnMobile />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyStructuredData}
                aria-label="Copiar Datos"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-status-delivered" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">{copied ? '¡Copiado!' : 'Copiar Datos'}</span>
              </Button>
            </div>
          </div>
        </Card>

        {/* Comentarios y Observaciones */}
        <CommentsPanel
          comments={order.comments}
          value={newComment}
          onChange={setNewComment}
          variant="billing"
          onSubmit={handleSaveComment}
          submitting={savingComment || submitting || bulkSaving || hasPendingPostControlWrites}
        />

        {/* Panel de Análisis Multidimensional de Descuentos */}
        <Card className="space-y-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText className="h-4 w-4 text-action-text" aria-hidden="true" /> Análisis
            Multidimensional de Descuentos
          </h3>
          <p className="text-xs text-muted">
            Desglose financiero calculado con los porcentajes congelados en cada línea del pedido,
            agrupados por marca.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border bg-surface-muted border-border  ">
              <span className="text-[11px] uppercase tracking-wider text-muted">
                1. Descuento Aplicado
              </span>
              <p className="mt-1 text-xl font-semibold text-action-text">
                {formatDiscountRange(discountSummary)}
              </p>
              <p className="text-[11px] mt-1 text-muted">
                Porcentajes guardados al crear el pedido; no cambian si se edita la ficha del
                cliente.
              </p>
            </div>

            <div className="p-4 rounded-lg border bg-surface-muted border-border  ">
              <span className="text-[11px] uppercase tracking-wider text-muted">
                2. Descuentos por Marca
              </span>
              <div className="mt-1 space-y-1 max-h-24 overflow-y-auto">
                {discountSummary.brands.length > 0 ? (
                  discountSummary.brands.map((brand) => (
                    <div
                      key={brand.brandId ?? brand.brandName}
                      className="flex justify-between text-xs"
                    >
                      <span className="text-foreground">{brand.brandName}:</span>
                      <span className="font-bold text-status-delivered">
                        {formatBrandDiscount(brand)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted italic">
                    No hay líneas facturables con descuentos aplicados.
                  </p>
                )}
              </div>
              <p className="text-[11px] mt-1 text-muted">
                Porcentaje congelado en las líneas de cada marca, incluidos los ajustes manuales.
              </p>
            </div>

            <div className="p-4 rounded-lg border bg-surface-muted border-border  ">
              <span className="text-[11px] uppercase tracking-wider text-muted">
                3. Ítems / Impacto Financiero
              </span>
              <p className="text-xl font-bold mt-1 text-status-delivered">
                -${discountSummary.totalDiscount.toFixed(2)}
              </p>
              <p className="text-[11px] mt-1 text-muted">
                Descuento Efectivo: {discountSummary.effectiveDiscountPercentage.toFixed(1)}% del
                subtotal.
              </p>
            </div>
          </div>
        </Card>

        {/* Tabla de ítems con información detallada de descuentos (incluye faltantes en 0) */}
        <Card className="space-y-6 ">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <h3 className="text-sm font-bold flex items-center gap-2 text-foreground">
              <Package className="w-4 h-4 text-action-text" /> Detalle de Ítems Verificados y
              Descuentos
            </h3>
            <span className="text-xs text-muted">
              Mostrando {billingItems.length} ítems
              {missingItems.length > 0
                ? ` (${missingItems.length} ${MISSING_LINE_LABEL.toLowerCase()})`
                : ''}
            </span>
          </div>

          {showLineFilters && (
            <div className="space-y-2" data-testid="billing-line-filters">
              <OrderLineFilters
                counts={lineFilterCounts}
                filter={lineFilter}
                onFilterChange={handleLineFilterChange}
                query={lineSearch}
                onQueryChange={handleLineSearchChange}
              />
              <p className="text-[10px] text-muted" role="status">
                Mostrando {visibleBillingItems.length} de {billingItems.length} líneas
              </p>
            </div>
          )}

          {canControlLines && (
            <div
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between bg-surface-muted border-border  "
              data-testid="billing-bulk-control"
            >
              <div>
                <p
                  className={`text-sm font-semibold ${
                    pendingControlCount > 0 ? 'text-status-draft' : 'text-status-delivered'
                  }`}
                  role="status"
                  data-testid="billing-pending-count"
                >
                  {pendingControlCount > 0 ? `${pendingControlCount} pendientes` : 'Sin pendientes'}
                </p>
                <p className="text-[11px] text-muted">
                  Las líneas con diferencia se conservan tal cual.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setConfirmBulkOpen(true)}
                  disabled={
                    pendingControlCount === 0 ||
                    hasPendingPostControlWrites ||
                    bulkSaving ||
                    savingComment ||
                    submitting ||
                    isNavigating
                  }
                  data-testid="billing-mark-all-ok"
                >
                  <CheckCheck className="h-4 w-4" aria-hidden="true" /> Marcar todas OK
                </Button>
                {undoControls && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleUndoPostControl}
                    disabled={
                      bulkSaving || savingComment || hasPendingPostControlWrites || isNavigating
                    }
                    data-testid="billing-undo-control"
                  >
                    <Undo2 className="h-4 w-4" aria-hidden="true" /> Deshacer
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="space-y-4">
            {visibleBillingItems.length === 0 && (
              <div className="rounded-lg border border-border bg-surface-muted px-4 py-8 text-center text-xs text-muted">
                {billingItems.length === 0
                  ? 'Este pedido no tiene líneas facturables.'
                  : 'No hay líneas que coincidan con el filtro.'}
              </div>
            )}

            {/* Mobile Card View */}
            <div className="block sm:hidden space-y-3">
              {visibleBillingItems.map((item) => {
                const finalQty = lineQuantity(item);
                const isMissing = item.lineTotal === 0;
                const pendingDetail = pendingDetailOf(item);
                return (
                  <div
                    key={`mob-${item._id}`}
                    data-testid="billing-item-card"
                    className={`p-4 rounded-lg border transition ${
                      isMissing
                        ? 'bg-status-blocked-soft border-status-blocked-border'
                        : 'bg-surface-muted border-border  '
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2 mb-2">
                      <div>
                        <span className="font-mono text-xs text-muted">
                          {item.productCode ?? item.productId?.code}
                        </span>
                        <h4 className="font-medium text-sm mt-0.5 text-foreground">
                          {item.productName ?? item.productId?.name}
                        </h4>
                        <span className="text-[10px] text-action-text">
                          {item.brandName ?? item.productId?.brandId?.name}
                        </span>
                        {isMissing ? (
                          <span className="block mt-1 text-[10px] font-semibold text-status-blocked">
                            {MISSING_LINE_LABEL}
                          </span>
                        ) : pendingDetail ? (
                          <span className="block mt-1 text-[10px] font-semibold text-status-draft">
                            Motivo pendiente
                          </span>
                        ) : null}
                      </div>
                      <span
                        className={`font-bold text-sm ${isMissing ? 'text-status-blocked' : 'text-status-delivered'}`}
                      >
                        ${item.lineTotal.toFixed(2)}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-3 mt-3 border-t text-center border-border">
                      <div>
                        <span className="block text-[10px] uppercase font-semibold text-muted">
                          Cant.
                        </span>
                        <span
                          className={`font-bold ${isMissing ? 'text-status-blocked' : 'text-status-delivered'}`}
                        >
                          {finalQty}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] uppercase font-semibold text-muted">
                          Precio U.
                        </span>
                        <span className="font-mono text-xs text-foreground">
                          ${item.unitPrice.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] uppercase font-semibold text-muted">
                          Desc.
                        </span>
                        <span className="px-2 py-0.5 bg-status-draft-soft text-status-draft rounded-lg text-xs font-semibold inline-block border border-status-draft-border">
                          {item.itemDiscount || 0}%
                        </span>
                      </div>
                    </div>

                    {pendingDetail && (
                      <p
                        className={`mt-3 text-[11px] ${isMissing ? 'text-status-blocked' : 'text-status-draft'}`}
                      >
                        Motivo: {pendingDetail}
                      </p>
                    )}

                    <div className="mt-3 pt-3 border-t flex items-center justify-between gap-2 border-border">
                      <span className="text-[10px] uppercase font-semibold text-muted">
                        Control post-factura
                      </span>
                      <PostControlSelector
                        value={item.postControl}
                        disabled={!canControlLines || bulkSaving || savingComment}
                        saving={savingPostControlIds.has(item._id)}
                        onChange={(next) => handleSetPostControl(item._id, next)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop Table View */}
            {billingItems.length > 0 && (
              <div className="hidden sm:block">
                <Table dense>
                  <TableHead>
                    <TableHeaderRow>
                      <TableHeaderCell>Código</TableHeaderCell>
                      <TableHeaderCell>Producto</TableHeaderCell>
                      <TableHeaderCell align="center">Cant. Verificada</TableHeaderCell>
                      <TableHeaderCell align="right">Precio Unit.</TableHeaderCell>
                      <TableHeaderCell align="center">Desc. (%)</TableHeaderCell>
                      <TableHeaderCell align="right">Total Línea</TableHeaderCell>
                      <TableHeaderCell>Estado</TableHeaderCell>
                      <TableHeaderCell>Control</TableHeaderCell>
                    </TableHeaderRow>
                  </TableHead>
                  <TableBody>
                    {visibleBillingItems.map((item) => {
                      const finalQty = lineQuantity(item);
                      const isMissing = item.lineTotal === 0;
                      const pendingDetail = pendingDetailOf(item);
                      return (
                        <TableRow
                          key={item._id}
                          className={`transition ${
                            isMissing
                              ? 'bg-status-blocked-soft hover:brightness-95'
                              : 'hover:bg-surface-muted'
                          }`}
                        >
                          <TableCell className="font-mono text-xs text-foreground">
                            {item.productCode ?? item.productId?.code}
                          </TableCell>
                          <TableCell className="font-medium text-foreground">
                            {item.productName ?? item.productId?.name}
                            <span className="block text-[10px] text-action-text">
                              {item.brandName ?? item.productId?.brandId?.name}
                            </span>
                          </TableCell>
                          <TableCell
                            align="center"
                            className={`font-bold ${isMissing ? 'text-status-blocked' : 'text-status-delivered'}`}
                          >
                            {finalQty}
                          </TableCell>
                          <TableCell align="right" className="font-mono text-foreground">
                            ${item.unitPrice.toFixed(2)}
                          </TableCell>
                          <TableCell align="center">
                            <span className="px-2 py-0.5 bg-status-draft-soft text-status-draft rounded-lg text-xs font-semibold border border-status-draft-border">
                              {item.itemDiscount || 0}%
                            </span>
                          </TableCell>
                          <TableCell
                            align="right"
                            className={`font-semibold ${isMissing ? 'text-status-blocked' : 'text-foreground'}`}
                          >
                            ${item.lineTotal.toFixed(2)}
                          </TableCell>
                          <TableCell>
                            {isMissing ? (
                              <div>
                                <span className="inline-block px-2 py-0.5 bg-status-blocked-soft text-status-blocked rounded-lg text-[10px] font-semibold border border-status-blocked-border">
                                  {MISSING_LINE_LABEL}
                                </span>
                                <span className="block mt-1 text-[10px] text-muted">
                                  {pendingDetail}
                                </span>
                              </div>
                            ) : pendingDetail ? (
                              <div>
                                <span className="inline-block px-2 py-0.5 bg-status-draft-soft text-status-draft rounded-lg text-[10px] font-semibold border border-status-draft-border">
                                  Faltante parcial
                                </span>
                                <span className="block mt-1 text-[10px] text-muted">
                                  {pendingDetail}
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-subtle">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <PostControlSelector
                              value={item.postControl}
                              disabled={!canControlLines || bulkSaving || savingComment}
                              saving={savingPostControlIds.has(item._id)}
                              onChange={(next) => handleSetPostControl(item._id, next)}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="ml-auto max-w-sm space-y-2 rounded-lg border border-border bg-surface-muted p-4 text-sm">
            <div className="flex justify-between text-subtle">
              <span>Subtotal:</span>
              <span>${order.subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-subtle">
              <span>Descuentos Totales:</span>
              <span className="text-status-delivered">-${order.totalDiscount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-foreground">
              <span>Total a Facturar:</span>
              <span className="text-action-text">${order.finalTotal.toFixed(2)}</span>
            </div>
          </div>

          {/* Resumen del control post-factura por línea */}
          {(order.status === 'facturacion' || order.status === 'control_post_factura') && (
            <div
              className={`flex items-start gap-3 rounded-lg border p-4 ${
                pendingControlCount > 0
                  ? 'bg-status-draft-soft border-status-draft-border'
                  : 'bg-status-delivered-soft border-status-delivered-border'
              }`}
            >
              {pendingControlCount > 0 ? (
                <AlertTriangle className="w-5 h-5 shrink-0 text-status-draft" />
              ) : (
                <ClipboardCheck className="w-5 h-5 shrink-0 text-status-delivered" />
              )}
              <div>
                <p
                  className={`text-sm font-semibold ${pendingControlCount > 0 ? 'text-status-draft' : 'text-status-delivered'}`}
                >
                  {pendingControlCount > 0
                    ? `Quedan ${pendingControlCount} ${pendingControlCount === 1 ? 'línea sin controlar' : 'líneas sin controlar'}`
                    : 'Todas las líneas están controladas'}
                </p>
                <p className="text-xs mt-1 text-muted">
                  {pendingControlCount > 0
                    ? 'Marcá cada línea como OK o Diferencia para habilitar la confirmación de despacho.'
                    : 'Ya podés confirmar el despacho del pedido.'}
                </p>
              </div>
            </div>
          )}

          {/* Botones de control de ciclo (escritorio; en mobile van en la barra fija) */}
          <div className="mt-8 flex flex-col gap-4 pt-4 border-t border-border">
            <div className="hidden lg:flex flex-col sm:flex-row gap-4 justify-end">
              {order.status === 'facturacion' && (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => handleUpdateStatus('control_post_factura')}
                  disabled={
                    submitting || savingComment || isNavigating || hasPendingPostControlWrites
                  }
                  className="px-6 py-3"
                >
                  {submitting ? 'Procesando...' : 'Marcar Facturado (Iniciar Control Post-Factura)'}
                </Button>
              )}

              {(order.status === 'facturacion' || order.status === 'control_post_factura') && (
                <Button
                  variant={order.status === 'control_post_factura' ? 'primary' : 'secondary'}
                  size="lg"
                  onClick={() => handleUpdateStatus('entregado')}
                  disabled={
                    submitting ||
                    savingComment ||
                    isNavigating ||
                    hasPendingPostControlWrites ||
                    pendingControlCount > 0
                  }
                  title={
                    pendingControlCount > 0
                      ? `Faltan ${pendingControlCount} ${pendingControlCount === 1 ? 'línea' : 'líneas'} por controlar`
                      : undefined
                  }
                  className="px-6 py-3"
                >
                  {submitting ? 'Procesando...' : 'Confirmar Despacho (Marcar como Entregado)'}
                </Button>
              )}
            </div>

            {order.status === 'entregado' && (
              <div className="flex items-center gap-2 rounded-lg border border-status-delivered-border bg-status-delivered-soft px-4 py-3 text-sm font-medium text-status-delivered">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> Ciclo Cerrado: Pedido
                Entregado y Despachado
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Barra fija inferior de mobile con el contador y la acción final. */}
      {showFinalAction && (
        <div
          data-testid="billing-action-bar"
          aria-hidden={inputFocused || undefined}
          inert={inputFocused || undefined}
          className={`fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-elevation-2 backdrop-blur-md transition-all duration-200 motion-reduce:transition-none lg:hidden ${
            inputFocused
              ? 'translate-y-full opacity-0 pointer-events-none'
              : 'translate-y-0 opacity-100'
          }`}
        >
          <div className="min-w-0">
            <p className="text-[10px] uppercase font-semibold text-muted">Sin controlar</p>
            <p
              className={`text-lg font-extrabold ${
                pendingControlCount > 0 ? 'text-status-draft' : 'text-status-delivered'
              }`}
              data-testid="billing-mobile-pending-count"
              role="status"
            >
              {pendingControlCount}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {canMarkInvoiced && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleUpdateStatus('control_post_factura')}
                disabled={
                  submitting || savingComment || isNavigating || hasPendingPostControlWrites
                }
                className="min-w-0 flex-1 px-3 py-2.5 text-[11px] font-semibold"
                data-testid="billing-mark-invoiced"
              >
                Marcar Facturado
              </Button>
            )}
            <Button
              variant={canMarkInvoiced ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => handleUpdateStatus('entregado')}
              disabled={finalActionDisabled}
              title={
                finalActionDisabled && pendingControlCount > 0
                  ? `Faltan ${pendingControlCount} ${pendingControlCount === 1 ? 'línea' : 'líneas'} por controlar`
                  : undefined
              }
              className="min-w-0 flex-1 px-3 py-2.5 text-xs font-semibold"
              data-testid="billing-final-action"
            >
              {submitting ? 'Procesando...' : 'Confirmar Despacho'}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmBulkOpen}
        title="Marcar todas OK"
        message={`Se van a marcar ${pendingControlCount} ${
          pendingControlCount === 1 ? 'línea pendiente' : 'líneas pendientes'
        } como OK. Las líneas con diferencia se mantienen y podés deshacer la acción.`}
        confirmLabel="Marcar todas OK"
        variant="primary"
        onClose={() => setConfirmBulkOpen(false)}
        onConfirm={handleMarkAllOk}
      />
    </AppShell>
  );
}
