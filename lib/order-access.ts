/**
 * Política de lectura de pedidos por rol.
 *
 * Es un módulo puro (sin Mongoose ni Next) para poder usarlo tanto en los
 * route handlers como en los tests. La escritura conserva sus reglas en
 * lib/authz.ts; acá sólo se define qué pedidos puede leer cada rol.
 *
 * - admin, controlador y billing mantienen el alcance operativo actual: ven
 *   todos los pedidos.
 * - vendedor sólo ve los pedidos que creó. Los pedidos nuevos se identifican
 *   por `createdById`; los históricos (sin ese campo) caen al `createdBy`
 *   denormalizado, que guarda el username del vendedor.
 */

import type { UserRole } from './authz';

export interface OrderAccessSession {
  userId: string;
  username: string;
  role: UserRole;
}

export interface OrderAccessOrder {
  createdById?: unknown;
  createdBy?: string | null;
}

/** Normaliza el id guardado en el pedido (ObjectId, string o documento poblado). */
function orderCreatorId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;

  if (typeof value === 'object') {
    const candidate = value as {
      _id?: unknown;
      toHexString?: () => string;
    };

    if (typeof candidate.toHexString === 'function') {
      const hex = candidate.toHexString();
      return hex.length > 0 ? hex : null;
    }

    if (candidate._id !== undefined && candidate._id !== value) {
      return orderCreatorId(candidate._id);
    }
  }

  const text = String(value);
  return text.length > 0 && text !== '[object Object]' ? text : null;
}

/**
 * ¿Puede este rol listar todos los pedidos? Los roles operativos conservan su
 * alcance actual; el vendedor queda limitado a sus propios pedidos.
 */
export function canListAllOrders(role: UserRole): boolean {
  return role === 'admin' || role === 'controlador' || role === 'billing';
}

/**
 * ¿Puede la sesión leer este pedido?
 *
 * Para el vendedor, `createdById` manda cuando existe. El fallback por
 * `createdBy` aplica sólo a pedidos históricos sin id, para que un pedido
 * nuevo con id de otro usuario no se habilite por una coincidencia de nombre.
 */
export function canReadOrder(session: OrderAccessSession, order: OrderAccessOrder): boolean {
  if (canListAllOrders(session.role)) return true;
  if (session.role !== 'vendedor') return false;

  const creatorId = orderCreatorId(order.createdById);
  if (creatorId) return creatorId === session.userId;

  return order.createdBy === session.username;
}

/**
 * Filtro Mongo para el listado de pedidos, o `null` si el rol ve todo.
 *
 * `{ createdById: null }` también matchea documentos donde el campo no existe,
 * así que cubre los pedidos históricos sin distinguir `null` de ausente.
 */
export function buildOrderReadFilter(session: OrderAccessSession): Record<string, unknown> | null {
  if (canListAllOrders(session.role)) return null;

  if (session.role !== 'vendedor') {
    // Rol desconocido: no listar nada en vez de filtrar de menos.
    return { _id: null };
  }

  return {
    $or: [{ createdById: session.userId }, { createdById: null, createdBy: session.username }],
  };
}
