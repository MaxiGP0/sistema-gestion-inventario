/**
 * Acciones compartidas de "Duplicar pedido".
 *
 * La clave de idempotencia se conserva por usuario+pedido mientras el pedido
 * no se haya duplicado con éxito: si la red falla después de que el servidor
 * guardó el borrador, reintentar devuelve ese mismo pedido en vez de crear otro.
 */

import { api } from './api-client';
import type { OrderDuplicateResponse } from './types';

export const DUPLICATE_CONFIRMATION = {
  title: 'Duplicar pedido',
  message:
    'Se creará un borrador nuevo con las mismas cantidades, recalculando precios y descuentos vigentes. ¿Continuar?',
  confirmLabel: 'Duplicar',
  variant: 'primary' as const,
};

const pendingRequestIds = new Map<string, string>();

function requestKey(orderId: string, userId?: string | null): string {
  return `${userId ?? 'anonimo'}:${orderId}`;
}

function createRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }

  return `dup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Clave estable para reintentos del mismo usuario sobre el mismo pedido. */
export function getDuplicateRequestId(orderId: string, userId?: string | null): string {
  const key = requestKey(orderId, userId);
  const pending = pendingRequestIds.get(key);
  if (pending) return pending;

  const requestId = createRequestId();
  pendingRequestIds.set(key, requestId);
  return requestId;
}

/** Se llama sólo cuando el servidor confirmó la creación del borrador. */
export function clearDuplicateRequestId(
  orderId: string,
  userId: string | null | undefined,
  requestId: string,
): void {
  const key = requestKey(orderId, userId);
  if (pendingRequestIds.get(key) === requestId) pendingRequestIds.delete(key);
}

export function duplicateOrder(orderId: string, requestId: string) {
  return api.post<OrderDuplicateResponse>(`/api/orders/${orderId}/duplicate`, undefined, {
    headers: { 'Idempotency-Key': requestId },
  });
}

/** Mensaje de éxito que incluye el detalle de las líneas omitidas. */
export function buildDuplicateSuccessMessage(response: OrderDuplicateResponse): string {
  const base = response.message || 'Pedido duplicado exitosamente';
  if (response.omittedItems.length === 0) return base;

  const details = response.omittedItems.slice(0, 3).map((item) => {
    const label = item.productCode ?? item.productName ?? item.productId;
    return `${label} (${item.reason === 'inactive' ? 'inactivo' : 'no encontrado'})`;
  });
  const remaining = response.omittedItems.length - details.length;
  const suffix = remaining > 0 ? ` y ${remaining} más` : '';

  return `${base}. Se omitieron ${response.omittedItems.length} ítem(s): ${details.join(', ')}${suffix}.`;
}
