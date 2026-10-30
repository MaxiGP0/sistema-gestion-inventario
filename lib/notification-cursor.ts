import { buildCursorFilter, decodeCursor, encodeCursor, type Cursor } from './cursor';

/** Cursor de la bandeja de notificaciones (`createdAt` + `_id`). */
export type NotificationCursor = Cursor;

/** Serializa la última notificación de una página como cursor opaco. */
export const encodeNotificationCursor = encodeCursor;

/** Decodifica un cursor de notificaciones; `null` si está corrupto. */
export const decodeNotificationCursor = decodeCursor;

/** Filtro "después del cursor" para el orden `{ createdAt: -1, _id: -1 }`. */
export const buildNotificationCursorFilter = buildCursorFilter;
