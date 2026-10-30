import { Types } from 'mongoose';

/**
 * Cursor de paginación genérico para listados ordenados por
 * `{ createdAt: -1, _id: -1 }`.
 *
 * El cursor guarda ambos valores: con sólo `createdAt` se perderían o
 * repetirían documentos cuando varios comparten el mismo timestamp.
 */
export interface Cursor {
  createdAt: Date;
  id: Types.ObjectId;
}

interface SerializedCursor {
  createdAt: string;
  id: string;
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** Serializa el último documento de una página como cursor opaco (base64url). */
export function encodeCursor(document: { _id: unknown; createdAt: Date | string }): string {
  const createdAt =
    document.createdAt instanceof Date ? document.createdAt : new Date(document.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error('No se puede codificar un cursor sin createdAt válido');
  }

  const id = String(document._id);
  if (!OBJECT_ID_PATTERN.test(id)) {
    throw new Error('No se puede codificar un cursor con un _id inválido');
  }

  const payload: SerializedCursor = { createdAt: createdAt.toISOString(), id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodifica un cursor. Devuelve `null` cuando el valor está corrupto o no
 * tiene la forma esperada, para que la ruta responda 400 en vez de ejecutar
 * una consulta inválida.
 */
export function decodeCursor(cursor: string): Cursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<SerializedCursor> | null;

    if (!parsed || typeof parsed !== 'object') return null;

    const createdAt = new Date(String(parsed.createdAt ?? ''));
    const id = String(parsed.id ?? '');

    if (Number.isNaN(createdAt.getTime()) || !OBJECT_ID_PATTERN.test(id)) {
      return null;
    }

    return { createdAt, id: new Types.ObjectId(id) };
  } catch {
    return null;
  }
}

/**
 * Filtro "después del cursor" para el orden `{ createdAt: -1, _id: -1 }`.
 * La segunda rama cubre los documentos con el mismo `createdAt` que el cursor.
 */
export function buildCursorFilter(cursor: Cursor) {
  return {
    $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ],
  };
}
