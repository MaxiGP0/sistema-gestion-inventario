'use client';

import { memo } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Archive,
  Building2,
  Clock,
  Copy,
  MessageSquare,
  Pencil,
  Trash2,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import StatusBadge from '@/components/StatusBadge';
import { DASHBOARD_TIME_ZONE } from '@/lib/dashboard-time';
import {
  buildOrderProductPreview,
  getOrderLastComment,
  getOrderPendingSummary,
} from '@/lib/order-card-preview';
import { formatInvoiceType, formatPaymentCondition } from '@/lib/order-commercial';
import { formatOrderShortId } from '@/lib/order-short-id';
import type { OrderSummaryDTO } from '@/lib/types';

// Formato explícito y zona del negocio: evita que Node y el navegador
// rendericen horas distintas durante la hidratación (`p. m.` vs `p.m.`).
const ORDER_DATE_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: DASHBOARD_TIME_ZONE,
});
const ORDER_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: DASHBOARD_TIME_ZONE,
});

export type OrderListVariant = 'deposit' | 'billing' | 'vendor';

/** Pedido del listado liviano compartido por las bandejas. */
export type OrderSummary = OrderSummaryDTO;

interface VariantStyles {
  hover: string;
  clock: string;
  archivedButton: string;
  building: string;
  itemsLabel: string;
  totalLabel: string;
  totalValue: string;
  actionLabel: string;
  archiveTitle: (archived: boolean | undefined) => string;
}

const CARD_STYLES: Record<OrderListVariant, VariantStyles> = {
  deposit: {
    hover: 'hover:border-action/50',
    clock: 'text-subtle',
    archivedButton: 'bg-action-soft hover:bg-action-soft-hover',
    building: 'text-action-text',
    itemsLabel: 'Ítems solicitados:',
    totalLabel: 'Total:',
    totalValue: 'text-foreground',
    actionLabel: 'Ver / Verificar Pedido',
    archiveTitle: (archived) => (archived ? 'Desarchivar pedido' : 'Archivar pedido'),
  },
  billing: {
    hover: 'hover:border-action/50',
    clock: 'text-subtle',
    archivedButton: 'bg-action-soft hover:bg-action-soft-hover',
    building: 'text-action-text',
    itemsLabel: 'Ítems verificados:',
    totalLabel: 'Total Final:',
    totalValue: 'text-foreground',
    actionLabel: 'Ver Datos Estructurados',
    archiveTitle: (archived) => (archived ? 'Desarchivar factura' : 'Archivar factura'),
  },
  vendor: {
    hover: 'hover:border-action/50',
    clock: 'text-subtle',
    archivedButton: 'bg-action-soft hover:bg-action-soft-hover',
    building: 'text-action-text',
    itemsLabel: 'Ítems solicitados:',
    totalLabel: 'Total:',
    totalValue: 'text-foreground',
    actionLabel: 'Ver Detalle del Pedido',
    archiveTitle: (archived) => (archived ? 'Desarchivar pedido' : 'Archivar pedido'),
  },
};

interface OrderListCardProps {
  order: OrderSummary;
  variant: OrderListVariant;
  /** Ruta del botón principal y, si `clickable`, de la tarjeta completa. */
  href: string;
  /** Si la tarjeta completa navega (cursor-pointer). */
  clickable?: boolean;
  /** Muestra el botón de eliminar (acción destructiva: solo admin). */
  canDelete?: boolean;
  /**
   * Callbacks estables que reciben el id (y datos de versión) del pedido.
   * Al no crear una arrow function por tarjeta, `memo` evita re-renderizar
   * toda la lista cuando cambia el buscador o cualquier estado del padre.
   */
  onArchive: (
    orderId: string,
    archived: boolean | undefined,
    version: number | undefined,
    event: React.MouseEvent,
  ) => void;
  onDelete: (orderId: string, event: React.MouseEvent) => void;
  /** Sólo en "Mis pedidos": precarga el pedido en /orders/new para revisarlo. */
  onDuplicate?: (orderId: string, event: React.MouseEvent) => void;
}

/**
 * Tarjeta de pedido compartida por las bandejas de depósito y facturación.
 * Cada variante reproduce las clases, textos y acentos de su página original.
 * Está memoizada: sus props son datos del pedido y callbacks estables.
 */
const OrderListCard = memo(function OrderListCard({
  order,
  variant,
  href,
  clickable = false,
  canDelete = false,
  onArchive,
  onDelete,
  onDuplicate,
}: OrderListCardProps) {
  const router = useRouter();
  const styles = CARD_STYLES[variant];

  const orderDate = new Date(order.createdAt);
  const hasValidDate = !Number.isNaN(orderDate.getTime());
  const formattedDate = hasValidDate ? ORDER_DATE_FORMATTER.format(orderDate) : '—';
  const formattedTime = hasValidDate ? ORDER_TIME_FORMATTER.format(orderDate) : '—';
  const clientName = order.clientName ?? order.clientId?.name;
  const clientCode = order.clientCode ?? order.clientId?.code;
  const productPreview = buildOrderProductPreview(order);
  const pendingSummary = getOrderPendingSummary(order);
  const lastComment = getOrderLastComment(order);
  const commercialSummary = [
    order.invoiceType ? formatInvoiceType(order.invoiceType) : null,
    order.paymentCondition ? formatPaymentCondition(order.paymentCondition) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const pendingLabel = pendingSummary
    ? pendingSummary.count > 0
      ? `${pendingSummary.count} ${pendingSummary.count === 1 ? 'línea' : 'líneas'} con faltante`
      : 'Pedido paralizado'
    : '';

  return (
    <Card
      data-order-card="true"
      data-order-id={order._id}
      onClick={clickable ? () => router.push(href) : undefined}
      className={`cv-list-item cv-order-card flex flex-col justify-between ${clickable ? 'cursor-pointer' : ''} ${styles.hover}`}
    >
      <div>
        <div className="mb-4 flex flex-wrap justify-between items-start gap-2">
          <StatusBadge variant={variant} status={order.status} />
          <div className="flex items-center gap-2">
            <div className="text-right font-mono text-[11px] leading-tight text-muted">
              <span className="flex items-center justify-end gap-1">
                <Clock className={`h-3.5 w-3.5 shrink-0 ${styles.clock}`} aria-hidden="true" />
                {formattedDate}
              </span>
              <span>{formattedTime} hs</span>
              <span
                data-testid="order-short-id"
                className="mt-0.5 block font-mono text-[11px] tracking-wide text-subtle"
                title="Código corto del pedido"
              >
                {formatOrderShortId(order._id)}
              </span>
            </div>
            <Button
              variant={order.archived ? 'secondary' : 'ghost'}
              size="icon-sm"
              onClick={(event) => onArchive(order._id, order.archived, order.version, event)}
              className={order.archived ? styles.archivedButton : undefined}
              title={styles.archiveTitle(order.archived)}
              aria-label={styles.archiveTitle(order.archived)}
            >
              <Archive className="h-4 w-4" aria-hidden="true" />
            </Button>
            {canDelete && (
              <Button
                tone="red"
                appearance="ghost"
                size="icon-sm"
                onClick={(event) => onDelete(order._id, event)}
                title="Eliminar pedido"
                aria-label="Eliminar pedido"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        <div className="mb-3 sm:mb-4">
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Building2 className={`h-4 w-4 shrink-0 ${styles.building}`} aria-hidden="true" />
            <span className="truncate">{clientName || 'Cliente desconocido'}</span>
          </h3>
          <p className="mt-1 font-mono text-xs text-muted">
            Código: {clientCode}{' '}
            {order.clientId?.localidad
              ? `(${order.clientId.localidad}${order.clientId?.province ? `, ${order.clientId.province}` : ''})`
              : order.clientId?.province
                ? `(${order.clientId.province})`
                : ''}
          </p>
        </div>

        {(pendingSummary || lastComment) && (
          <div className="mb-3 space-y-1.5 sm:mb-4">
            {pendingSummary && (
              <div
                data-testid="order-pending-alert"
                data-pending-lines={pendingSummary.count}
                className="flex items-start gap-1.5 rounded-md border border-status-draft-border bg-status-draft-soft px-2.5 py-1.5 text-[11px] leading-snug text-status-draft"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-semibold">{pendingLabel}</p>
                  {pendingSummary.reason && (
                    <p className="truncate" title={pendingSummary.reason}>
                      {pendingSummary.reason}
                    </p>
                  )}
                </div>
              </div>
            )}
            {lastComment && (
              <div
                data-testid="order-last-comment"
                className="flex items-center gap-1.5 rounded-md border border-border bg-surface-muted px-2.5 py-1.5 text-[11px] text-muted"
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
                <span className="truncate" title={lastComment}>
                  {lastComment}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="mb-4 space-y-1 rounded-md border border-border bg-surface-muted p-3 text-xs sm:mb-6">
          {productPreview && (
            <p
              data-testid="order-products-preview"
              title={productPreview}
              className="line-clamp-2 text-[11px] leading-snug text-muted"
            >
              {productPreview}
            </p>
          )}
          <div className="flex justify-between text-muted">
            <span>{styles.itemsLabel}</span>
            <span className="font-semibold text-foreground">{order.items.length} productos</span>
          </div>
          <div className="flex justify-between text-muted">
            <span>Vendedor:</span>
            <span className="text-foreground">{order.createdBy}</span>
          </div>
          {commercialSummary && (
            <div className="flex justify-between gap-3 text-muted">
              <span className="shrink-0">Comercial:</span>
              <span className="truncate text-right text-foreground" title={commercialSummary}>
                {commercialSummary}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-border pt-2 font-semibold text-foreground">
            <span>{styles.totalLabel}</span>
            <span className={`tabular-nums ${styles.totalValue}`}>
              ${order.finalTotal.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Button
          variant="secondary"
          fullWidth
          onClick={(e) => {
            e.stopPropagation();
            router.push(href);
          }}
          className="py-2.5 text-sm"
        >
          {styles.actionLabel}
        </Button>
        {variant === 'vendor' && order.status === 'borrador' && (
          <Button
            variant="secondary"
            fullWidth
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/orders/${order._id}/edit`);
            }}
            className="py-2 text-xs"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" /> Editar borrador
          </Button>
        )}
        {onDuplicate && (
          <Button
            variant="ghost"
            fullWidth
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(order._id, e);
            }}
            className="py-2 text-xs"
          >
            <Copy className="h-4 w-4" aria-hidden="true" /> Repetir pedido
          </Button>
        )}
      </div>
    </Card>
  );
});

export default OrderListCard;
