/**
 * Resumen de pedido para compartir por WhatsApp o copiar como texto plano.
 *
 * Módulo puro: recibe un DTO (o una proyección compatible) y devuelve un
 * string. No usa `navigator`, DOM ni Mongoose, así que puede ejecutarse tanto
 * en el cliente como en los tests sin base de datos.
 *
 * Los importes y descuentos salen del pedido congelado al crearlo/controlarlo.
 * Las líneas se listan completas, incluidas las pendientes o sin verificar:
 * el resumen es informativo y no reemplaza al comprobante fiscal.
 */

import { formatDiscountPercentage } from './billing-discounts';
import { roundCurrency } from './money';
import { formatInvoiceType, formatPaymentCondition } from './order-commercial';

/** Zona horaria usada por defecto para la fecha del comprobante. */
export const ORDER_SHARE_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** Etapa con la que se redacta el resumen: pedido o ya controlado. */
export type OrderShareMode = 'requested' | 'verified';

export interface OrderShareItemLike {
  productCode?: string | null;
  productName?: string | null;
  brandName?: string | null;
  productId?: {
    code?: string | null;
    name?: string | null;
    brandId?: { name?: string | null } | null;
  } | null;
  unitPrice?: number | null;
  requestedQuantity?: number | null;
  verifiedQuantity?: number | null;
  isPending?: boolean | null;
  pendingReason?: string | null;
  itemDiscount?: number | null;
  lineTotal?: number | null;
}

export interface OrderShareOrderLike {
  _id: string;
  status?: string | null;
  createdAt?: string | Date | null;
  createdBy?: string | null;
  clientId?: { code?: string | null; name?: string | null } | null;
  clientName?: string | null;
  clientCode?: string | null;
  paymentCondition?: string | null;
  paymentConditionDetail?: string | null;
  invoiceType?: string | null;
  subtotal?: number | null;
  totalDiscount?: number | null;
  finalTotal?: number | null;
  items?: readonly OrderShareItemLike[] | null;
}

export interface BuildOrderShareTextOptions {
  /** Zona horaria de la fecha; Argentina por defecto. */
  timeZone?: string;
}

const numberOrZero = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const textOrEmpty = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Importe con separador de miles y dos decimales (es-AR). */
function formatShareMoney(value: unknown): string {
  return `$ ${numberOrZero(value).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Número corto visible del pedido, igual al que muestran las pantallas. */
export function orderShareNumber(order: Pick<OrderShareOrderLike, '_id'>): string {
  return textOrEmpty(order._id).slice(-6) || '—';
}

/**
 * Fecha y hora legible para el resumen. Se formatea en la zona horaria del
 * negocio (o la indicada) para que el texto no cambie según el dispositivo.
 */
export function formatOrderShareDate(
  value?: string | Date | null,
  timeZone: string = ORDER_SHARE_TIME_ZONE,
): string {
  if (!value) return '—';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  try {
    const parts = new Intl.DateTimeFormat('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).formatToParts(date);

    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((candidate) => candidate.type === type)?.value ?? '';

    return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
  } catch {
    // Zona horaria inválida: se conserva un fallback legible.
    return date.toLocaleString('es-AR');
  }
}

/** Título corto para la hoja nativa de compartir. */
export function buildOrderShareTitle(order: Pick<OrderShareOrderLike, '_id'>): string {
  return `Sistema de Gestión de Inventario — Pedido #${orderShareNumber(order)}`;
}

/**
 * Un pedido sigue en etapa de solicitud cuando es un borrador y ninguna línea
 * fue controlada todavía. Si depósito ya verificó o dejó un faltante, el
 * resumen debe mostrar el estado real aunque el estado siga siendo borrador.
 */
export function orderShareMode(order: OrderShareOrderLike): OrderShareMode {
  if (order.status !== 'borrador') return 'verified';

  const items = order.items ?? [];
  const hasControlData = items.some(
    (item) =>
      numberOrZero(item.verifiedQuantity) > 0 ||
      Boolean(item.isPending) ||
      textOrEmpty(item.pendingReason) !== '',
  );

  return hasControlData ? 'verified' : 'requested';
}

/**
 * Importe de la línea con el que se redacta el resumen. Se prioriza el total
 * congelado del pedido; en pedidos históricos sin `lineTotal` se recalcula con
 * la cantidad de la etapa para no mostrar un importe en cero.
 */
function itemLineTotal(item: OrderShareItemLike, quantity: number): number {
  if (item.lineTotal !== undefined && item.lineTotal !== null) {
    const stored = Number(item.lineTotal);
    if (Number.isFinite(stored)) return stored;
  }

  const gross = numberOrZero(item.unitPrice) * quantity;
  return roundCurrency(gross - (gross * numberOrZero(item.itemDiscount)) / 100);
}

function itemLine(item: OrderShareItemLike, index: number, mode: OrderShareMode): string {
  const code = textOrEmpty(item.productCode) || textOrEmpty(item.productId?.code);
  const name =
    textOrEmpty(item.productName) || textOrEmpty(item.productId?.name) || 'Producto sin nombre';
  const brand =
    textOrEmpty(item.brandName) || textOrEmpty(item.productId?.brandId?.name) || 'Sin marca';

  const identity = code ? `[${code}] ${name}` : name;
  const requested = numberOrZero(item.requestedQuantity);
  const verified = numberOrZero(item.verifiedQuantity);
  const discount = formatDiscountPercentage(numberOrZero(item.itemDiscount));
  const unitPrice = formatShareMoney(item.unitPrice);

  if (mode === 'requested') {
    return (
      `${index + 1}. ${identity} (${brand})\n` +
      `   Cant.: ${requested} | Desc.: ${discount}% | Unit.: ${unitPrice} | ` +
      `Subtotal: ${formatShareMoney(itemLineTotal(item, requested))}`
    );
  }

  const pendingReason = textOrEmpty(item.pendingReason);
  const hasShortage = Boolean(item.isPending) || verified < requested || pendingReason !== '';
  const control = hasShortage
    ? `Pedida: ${requested} · Verificada: ${verified} · ${pendingReason || 'Faltante'}`
    : `Pedida: ${requested} · Verificada: ${verified}`;

  return (
    `${index + 1}. ${identity} (${brand})\n` +
    `   ${control} | Desc.: ${discount}% | Unit.: ${unitPrice} | ` +
    `Subtotal: ${formatShareMoney(itemLineTotal(item, verified))}`
  );
}

/**
 * Arma el texto plano del pedido. El resultado es estable y legible en
 * WhatsApp, Telegram o cualquier app de mensajes.
 */
export function buildOrderShareText(
  order: OrderShareOrderLike,
  options: BuildOrderShareTextOptions = {},
): string {
  const clientName =
    textOrEmpty(order.clientName) || textOrEmpty(order.clientId?.name) || 'Cliente sin informar';
  const clientCode = textOrEmpty(order.clientCode) || textOrEmpty(order.clientId?.code);
  const client = clientCode ? `${clientName} (${clientCode})` : clientName;
  const items = order.items ?? [];
  const mode = orderShareMode(order);

  const lines = [
    'SISTEMA DE GESTIÓN DE INVENTARIO',
    'Resumen de pedido',
    '',
    `Pedido: #${orderShareNumber(order)}`,
    `Fecha: ${formatOrderShareDate(order.createdAt, options.timeZone)}`,
    `Cliente: ${client}`,
    `Vendedor: ${textOrEmpty(order.createdBy) || '—'}`,
    `Condición de pago: ${formatPaymentCondition(
      order.paymentCondition,
      order.paymentConditionDetail,
    )}`,
    `Tipo de factura: ${formatInvoiceType(order.invoiceType)}`,
    '',
    'Detalle de líneas:',
  ];

  if (items.length === 0) {
    lines.push('Sin líneas cargadas.');
  } else {
    items.forEach((item, index) => {
      lines.push(itemLine(item, index, mode));
    });
  }

  lines.push(
    '',
    `Subtotal: ${formatShareMoney(order.subtotal)}`,
    `Descuentos: -${formatShareMoney(order.totalDiscount)}`,
    `TOTAL FINAL: ${formatShareMoney(order.finalTotal)}`,
  );

  return lines.join('\n');
}
