/**
 * Helpers compartidos por las rutas idempotentes de pedidos.
 *
 * `POST /api/orders` y `POST /api/orders/[id]/duplicate` usan la misma clave
 * (`clientRequestId` en el body o `Idempotency-Key` en el header) y el mismo
 * índice único parcial de `models/Order.ts`. Ante un reintento devuelven el
 * pedido ya creado por el mismo usuario; ante una carrera entre dos inserts,
 * el que pierde el índice único busca el documento ganador y también lo
 * devuelve en vez de exponer un 409.
 */

import { Order } from '@/models/Order';
import { MAX_CLIENT_REQUEST_ID_LENGTH } from './order-request-id';
import type { OrderDTO } from './types';

/**
 * Normaliza una clave recibida por header: `null` cuando no vino, `undefined`
 * cuando tiene forma inválida. La clave es opcional para no romper clientes
 * viejos.
 */
export function parseClientRequestId(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return null;

  const key = value.trim();
  if (!key || key.length > MAX_CLIENT_REQUEST_ID_LENGTH) return undefined;
  return key;
}

/** ¿El error de Mongo fue por violar un índice único? (E11000). */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    writeErrors?: Array<{ code?: unknown; err?: { code?: unknown } }>;
  };
  const firstWriteError = candidate.writeErrors?.[0];
  const code = Number(candidate.code ?? firstWriteError?.code ?? firstWriteError?.err?.code);
  return code === 11000;
}

/** Pedido ya creado por ese usuario con esa clave idempotente. */
export async function findOrderByClientRequestId(
  userId: string,
  clientRequestId: string,
): Promise<OrderDTO | null> {
  const existing = await Order.findOne({
    createdById: userId,
    clientRequestId,
  }).lean();

  return (existing as unknown as OrderDTO | null) ?? null;
}
