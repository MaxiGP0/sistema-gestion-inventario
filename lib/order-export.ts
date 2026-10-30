/**
 * Formato y helpers de la exportación de pedidos.
 *
 * Módulo puro y compartido por el route handler y la UI: define las columnas,
 * las filas, el escapado de CSV y el nombre del archivo. No importa Mongoose ni
 * Next para poder usarse en tests y en el cliente.
 */

import {
  formatInvoiceType,
  formatPaymentCondition,
  type InvoiceType,
  type PaymentCondition,
} from './order-commercial';

/** Tope de pedidos exportados en una sola respuesta. */
export const ORDER_EXPORT_MAX_ROWS = 10_000;

export const ORDER_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type OrderExportFormat = (typeof ORDER_EXPORT_FORMATS)[number];

export function isOrderExportFormat(value: unknown): value is OrderExportFormat {
  return (ORDER_EXPORT_FORMATS as readonly unknown[]).includes(value);
}

export const ORDER_EXPORT_CSV_BOM = '\uFEFF';
export const ORDER_EXPORT_CSV_DELIMITER = ';';
export const ORDER_EXPORT_CSV_MIME = 'text/csv; charset=utf-8';
export const ORDER_EXPORT_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface OrderExportColumn {
  header: string;
  width: number;
}

/** Columnas y anchos usados tanto por el CSV como por la hoja XLSX. */
export const ORDER_EXPORT_COLUMNS: readonly OrderExportColumn[] = [
  { header: 'ID', width: 26 },
  { header: 'Fecha', width: 22 },
  { header: 'Cliente', width: 32 },
  { header: 'Código de cliente', width: 18 },
  { header: 'Vendedor', width: 20 },
  { header: 'Estado', width: 22 },
  { header: 'Subtotal', width: 14 },
  { header: 'Descuento', width: 14 },
  { header: 'Total', width: 14 },
  { header: 'Condición de pago', width: 26 },
  { header: 'Tipo de factura', width: 16 },
  { header: 'Detalle de líneas', width: 90 },
];

export interface OrderExportItemLike {
  productCode?: string | null;
  productName?: string | null;
  brandName?: string | null;
  unitPrice?: number | null;
  requestedQuantity?: number | null;
  verifiedQuantity?: number | null;
  itemDiscount?: number | null;
  lineTotal?: number | null;
}

export interface OrderExportOrderLike {
  _id: unknown;
  createdAt?: Date | string | null;
  clientId?: { code?: string | null; name?: string | null } | null;
  clientName?: string | null;
  clientCode?: string | null;
  createdBy?: string | null;
  status?: string | null;
  subtotal?: number | null;
  totalDiscount?: number | null;
  finalTotal?: number | null;
  invoiceType?: InvoiceType | string | null;
  paymentCondition?: PaymentCondition | string | null;
  paymentConditionDetail?: string | null;
  items?: OrderExportItemLike[] | null;
}

/** Valor de una celda antes de serializarla a CSV. */
export type OrderExportCell = string | number | Date;

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function money(value: unknown): string {
  return numberOrZero(value).toFixed(2);
}

function itemLabel(item: OrderExportItemLike): string {
  const code = item.productCode?.trim();
  const name = item.productName?.trim();
  const brand = item.brandName?.trim();

  const identity = [code ? `[${code}]` : '', name ?? ''].filter(Boolean).join(' ');
  if (identity && brand) return `${identity} (${brand})`;
  return identity || brand || 'Línea';
}

/**
 * Texto del detalle de líneas: una línea por ítem con cantidades, precio,
 * descuento y total. Se conserva incluso para líneas en cero (faltantes).
 */
export function formatOrderItemDetails(
  items: readonly OrderExportItemLike[] | null | undefined,
): string {
  return (items ?? [])
    .map((item, index) => {
      const requested = numberOrZero(item.requestedQuantity);
      const verified = numberOrZero(item.verifiedQuantity);

      return (
        `${index + 1}. ${itemLabel(item)} | ` +
        `Pedida: ${requested} | Verificada: ${verified} | ` +
        `Precio: ${money(item.unitPrice)} | ` +
        `Descuento: ${numberOrZero(item.itemDiscount)}% | ` +
        `Total: ${money(item.lineTotal)}`
      );
    })
    .join('\n');
}

function exportDate(value: Date | string | null | undefined): Date | '' {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date;
}

/**
 * Convierte un pedido en la fila de celdas en el mismo orden que
 * `ORDER_EXPORT_COLUMNS`.
 */
export function buildOrderExportRow(order: OrderExportOrderLike): OrderExportCell[] {
  const clientName = order.clientName?.trim() || order.clientId?.name?.trim() || '';
  const clientCode = order.clientCode?.trim() || order.clientId?.code?.trim() || '';

  return [
    String(order._id),
    exportDate(order.createdAt),
    clientName,
    clientCode,
    order.createdBy ?? '',
    order.status ?? '',
    numberOrZero(order.subtotal),
    numberOrZero(order.totalDiscount),
    numberOrZero(order.finalTotal),
    formatPaymentCondition(order.paymentCondition, order.paymentConditionDetail),
    formatInvoiceType(order.invoiceType),
    formatOrderItemDetails(order.items),
  ];
}

/** Escapa un valor según RFC 4180 usando el separador de la exportación. */
export function escapeCsvValue(value: OrderExportCell | null | undefined): string {
  let text: string;

  if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  } else if (typeof value === 'number') {
    text = Number.isFinite(value) ? value.toFixed(2) : '';
  } else {
    text = value ?? '';
  }

  if (/["\r\n;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/** Serializa una fila CSV (sin salto de línea final). */
export function serializeOrderExportCsvRow(values: readonly OrderExportCell[]): string {
  return values.map(escapeCsvValue).join(ORDER_EXPORT_CSV_DELIMITER);
}

/** Cabecera CSV con BOM UTF-8 para que Excel reconozca los acentos. */
export function buildOrderExportCsvHeader(): string {
  return (
    ORDER_EXPORT_CSV_BOM +
    ORDER_EXPORT_COLUMNS.map((column) => escapeCsvValue(column.header)).join(
      ORDER_EXPORT_CSV_DELIMITER,
    )
  );
}

export interface OrderExportFilters {
  status?: string | null;
  archived?: string | null;
  search?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  clientId?: string | null;
}

/** URL del endpoint de exportación con los filtros activos de la bandeja. */
export function buildOrderExportUrl(
  format: OrderExportFormat,
  filters: OrderExportFilters = {},
): string {
  const params = new URLSearchParams({ format });

  if (filters.status) params.set('status', filters.status);
  if (filters.archived) params.set('archived', filters.archived);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.clientId) params.set('clientId', filters.clientId);

  return `/api/orders/export?${params.toString()}`;
}

/** Nombre de archivo estable por día y formato. */
export function buildOrderExportFilename(
  format: OrderExportFormat,
  date: Date = new Date(),
  prefix = 'pedidos',
): string {
  const day = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
  return `${prefix}-${day}.${format}`;
}

/** Extrae `filename`/`filename*` del header Content-Disposition. */
export function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;

  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      return utf8[1].trim();
    }
  }

  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1].trim();

  const plain = /filename=([^;]+)/i.exec(header);
  return plain?.[1]?.trim() || null;
}
