/**
 * Restauración de un alta fallida desde la cola offline al borrador de
 * `/orders/new`.
 *
 * El body encolado (`POST /api/orders`) ya tiene todo lo que necesita el
 * servidor, pero el formulario guarda su estado en otro formato
 * (`OrderDraft`). Este módulo hace la traducción sin tocar IndexedDB ni el DOM
 * para poder probarla en Node.
 */

import { clampDiscount, type OrderCatalogClient } from './order-catalog';
import { isInvoiceType, isPaymentCondition } from './order-commercial';
import { saveOrderDraft, type OrderDraft, type OrderDraftStorage } from './order-draft';
import type { PendingOrderRequest } from './offline-order-queue';

export interface QueueEntryDraftContext {
  /** Vendedor de la sesión actual; el borrador lo muestra en solo lectura. */
  salesperson: string;
  /** Clientes del snapshot offline para recuperar código/descuentos. */
  knownClients?: readonly OrderCatalogClient[];
}

export interface RestoreQueueEntryDraftInput extends QueueEntryDraftContext {
  userId: string;
  storage: OrderDraftStorage | null | undefined;
  /** Pedido a restaurar en modo edición (`sgi_order_draft:${userId}:edit:${orderId}`). */
  orderId?: string | null;
  /** Versión vigente del pedido en el servidor (opcional). */
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Indica si una entrada `update` de la cola corresponde a `mode: 'draft-edit'`. */
export function isDraftEditQueueEntry(entry: Pick<PendingOrderRequest, 'kind' | 'body'>): boolean {
  if (entry.kind !== 'update' || !isRecord(entry.body)) return false;
  return entry.body.mode === 'draft-edit';
}

function productIdOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isRecord(value) && typeof value._id === 'string') return value._id.trim();
  return '';
}

function positiveQuantity(value: unknown): number {
  const quantity = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity);
}

function discountOf(value: unknown): number | null {
  const discount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(discount)) return null;
  return clampDiscount(discount);
}

function fallbackClient(clientId: string, clientName: string | undefined): OrderCatalogClient {
  const trimmedName = clientName?.trim();
  return {
    _id: clientId,
    code: '',
    name: trimmedName || `Cliente ${clientId.slice(-6)}`,
  };
}

/**
 * Convierte el body de un alta fallida en el borrador que consume el alta.
 * Devuelve `null` si la entrada no es un alta o no tiene un `clientId` válido.
 *
 * Las cantidades y descuentos manuales se conservan. Los descuentos de cliente
 * y marca no se restauran por separado: el body ya trae el porcentaje resuelto
 * en `customDiscount` de cada línea, que es lo que el formulario vuelve a
 * enviar.
 */
export function buildOrderDraftFromQueueEntry(
  entry: Pick<PendingOrderRequest, 'kind' | 'body' | 'clientName' | 'orderId'>,
  context: QueueEntryDraftContext,
): OrderDraft | null {
  const isCreate = entry.kind === 'create';
  const isDraftEdit = isDraftEditQueueEntry(entry);
  if ((!isCreate && !isDraftEdit) || !isRecord(entry.body)) return null;

  const clientId = typeof entry.body.clientId === 'string' ? entry.body.clientId.trim() : '';
  if (isCreate && !clientId) return null;
  if (isDraftEdit && !entry.orderId?.trim() && !clientId) return null;

  const quantities: OrderDraft['quantities'] = {};
  const itemDiscounts: OrderDraft['itemDiscounts'] = {};

  if (Array.isArray(entry.body.items)) {
    for (const rawItem of entry.body.items) {
      if (!isRecord(rawItem)) continue;

      const productId = productIdOf(rawItem.productId);
      const quantity = positiveQuantity(rawItem.requestedQuantity);
      if (!productId || quantity <= 0) continue;

      quantities[productId] = (quantities[productId] ?? 0) + quantity;

      const discount = discountOf(rawItem.customDiscount);
      if (discount !== null) itemDiscounts[productId] = discount;
    }
  }

  let selectedClient: OrderCatalogClient | null = null;
  if (clientId) {
    const knownClient = context.knownClients?.find((client) => client._id === clientId);
    selectedClient = knownClient ?? fallbackClient(clientId, entry.clientName);
  } else if (entry.clientName?.trim()) {
    const trimmedName = entry.clientName.trim();
    const knownByName = context.knownClients?.find((client) => client.name === trimmedName);
    selectedClient =
      knownByName ?? fallbackClient(entry.orderId?.trim() || 'draft-edit', trimmedName);
  }

  const invoiceType = isInvoiceType(entry.body.invoiceType) ? entry.body.invoiceType : '';
  const paymentCondition = isPaymentCondition(entry.body.paymentCondition)
    ? entry.body.paymentCondition
    : '';

  return {
    quantities,
    selectedClient,
    salesperson: context.salesperson,
    comment: typeof entry.body.comment === 'string' ? entry.body.comment : '',
    itemDiscounts,
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType,
    paymentCondition,
    paymentConditionDetail:
      paymentCondition === 'otro' && typeof entry.body.paymentConditionDetail === 'string'
        ? entry.body.paymentConditionDetail
        : '',
  };
}

/**
 * Guarda el borrador restaurado para el usuario actual. Devuelve `false` si la
 * entrada no se puede traducir o el storage no está disponible; en ese caso el
 * llamador debe conservar la entrada fallida en la cola.
 */
export function restoreOrderDraftFromQueueEntry(
  input: RestoreQueueEntryDraftInput,
  entry: Pick<PendingOrderRequest, 'kind' | 'body' | 'clientName' | 'orderId'>,
): boolean {
  const draft = buildOrderDraftFromQueueEntry(entry, input);
  if (!draft) return false;

  const targetOrderId =
    input.orderId ?? (isDraftEditQueueEntry(entry) ? entry.orderId?.trim() : undefined);

  return saveOrderDraft(
    input.storage,
    draft,
    input.userId,
    targetOrderId ? { orderId: targetOrderId, version: input.version } : undefined,
  );
}
