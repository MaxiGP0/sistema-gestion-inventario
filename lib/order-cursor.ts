import { buildCursorFilter, decodeCursor, encodeCursor, type Cursor } from './cursor';

/**
 * Cursor de paginación para listados de pedidos.
 *
 * El listado se ordena por `createdAt` descendente y desempata por `_id`
 * descendente (el mismo orden que usa el índice compuesto). La implementación
 * es compartida con las notificaciones en `lib/cursor.ts`.
 */
export type OrderCursor = Cursor;

/** Serializa el último pedido de una página como cursor opaco (base64url). */
export const encodeOrderCursor = encodeCursor;

/** Decodifica un cursor de pedido; `null` si está corrupto. */
export const decodeOrderCursor = decodeCursor;

/** Filtro "después del cursor" para el orden `{ createdAt: -1, _id: -1 }`. */
export const buildOrderCursorFilter = buildCursorFilter;
