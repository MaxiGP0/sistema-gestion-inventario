import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { z } from 'zod';
import dbConnect from '@/lib/mongodb';
import { requireCurrentSession } from '@/lib/auth';
import { errorResponse, handleRouteError, parseQueryParams } from '@/lib/api-errors';
import { PRIVATE_REVALIDATE_HEADERS } from '@/lib/cache-control';
import { MAX_LIST_PAGE } from '@/lib/validations';
import { withRouteLogging } from '@/lib/logger';
import { Product } from '@/models/Product';
import { Client } from '@/models/Client';

/**
 * Snapshot incremental del catálogo para IndexedDB.
 *
 * GET /api/catalog/offline-snapshot?type=products|clients&cursor=…&since=…
 *
 * - Orden estable por `updatedAt` + `_id` (y cursor opaco con esa misma clave).
 * - Sin `since` devuelve el catálogo vigente; con `since` devuelve sólo los
 *   documentos modificados después de esa marca, incluidas las bajas lógicas de
 *   productos (`active: false`) para que el cliente las elimine.
 * - `serverTime` se toma antes de consultar: si un documento cambia mientras se
 *   pagina, su `updatedAt` queda por encima de la marca y el delta lo recupera.
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;

const PRODUCT_FIELDS = '_id code name brandId price priceWithIva imageUrl updatedAt active';
const CLIENT_FIELDS =
  '_id code name address localidad province generalDiscount brandDiscounts updatedAt';

const optionalTrimmedString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().max(2_048).optional());

const optionalPage = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : value;
}, z.number().int().min(1).max(MAX_LIST_PAGE).optional());

const optionalLimit = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed))) : value;
}, z.number().int().min(1).max(MAX_LIMIT));

const offlineSnapshotQuerySchema = z.object({
  type: z.enum(['products', 'clients']),
  cursor: optionalTrimmedString,
  page: optionalPage,
  since: optionalTrimmedString.refine(
    (value) => value === undefined || !Number.isNaN(Date.parse(value)),
    'since debe ser una fecha ISO válida',
  ),
  limit: optionalLimit,
});

interface SnapshotCursor {
  updatedAt: Date;
  id: string;
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(value: string): SnapshotCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor inválido');
  }

  const candidate = parsed as { updatedAt?: unknown; id?: unknown } | null;
  const updatedAt = typeof candidate?.updatedAt === 'string' ? new Date(candidate.updatedAt) : null;
  const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
  if (!updatedAt || Number.isNaN(updatedAt.getTime()) || !id) {
    throw new Error('cursor inválido');
  }

  return { updatedAt, id };
}

let snapshotIndexesReady: Promise<unknown> | null = null;

/**
 * Crea los índices del orden incremental una sola vez por proceso. Si falla
 * (por ejemplo, permisos de sólo lectura), la consulta sigue funcionando.
 */
function ensureSnapshotIndexes(): Promise<unknown> {
  if (!snapshotIndexesReady) {
    snapshotIndexesReady = Promise.all([
      Product.collection.createIndex({ updatedAt: 1, _id: 1 }),
      Client.collection.createIndex({ updatedAt: 1, _id: 1 }),
    ]).catch((error) => {
      snapshotIndexesReady = null;
      console.warn('No se pudieron crear los índices del snapshot offline:', error);
    });
  }

  return snapshotIndexesReady;
}

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedQuery = parseQueryParams(request, offlineSnapshotQuerySchema);
    if (!parsedQuery.success) return parsedQuery.response;

    const { type, cursor: rawCursor, page, since, limit } = parsedQuery.data;

    let cursor: SnapshotCursor | null = null;
    if (rawCursor) {
      try {
        cursor = decodeCursor(rawCursor);
      } catch {
        return errorResponse('El cursor del snapshot no es válido', 400);
      }
    }

    const sinceDate = since ? new Date(since) : null;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      return errorResponse('since debe ser una fecha ISO válida', 400);
    }

    await dbConnect();
    await ensureSnapshotIndexes();

    // Se toma antes de la consulta: cualquier cambio posterior queda cubierto
    // por el próximo delta (`updatedAt > serverTime`).
    const serverTime = new Date();
    const filters: Record<string, unknown>[] = [];

    if (sinceDate) filters.push({ updatedAt: { $gt: sinceDate } });
    if (type === 'products' && !sinceDate) filters.push({ active: { $ne: false } });
    if (cursor) {
      filters.push({
        $or: [
          { updatedAt: { $gt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, _id: { $gt: cursor.id } },
        ],
      });
    }

    const filter =
      filters.length === 0 ? {} : filters.length === 1 ? filters[0] : { $and: filters };

    const skip = cursor ? 0 : page && page > 1 ? (page - 1) * limit : 0;

    let documents: Array<Record<string, unknown>>;
    if (type === 'products') {
      let query = Product.find(filter).select(PRODUCT_FIELDS).sort({ updatedAt: 1, _id: 1 });
      if (skip > 0) query = query.skip(skip);
      documents = await query
        .populate('brandId', 'name codePrefix')
        .limit(limit + 1)
        .lean<Array<Record<string, unknown>>>();
    } else {
      let query = Client.find(filter).select(CLIENT_FIELDS).sort({ updatedAt: 1, _id: 1 });
      if (skip > 0) query = query.skip(skip);
      documents = await query.limit(limit + 1).lean<Array<Record<string, unknown>>>();
    }

    const hasMore = documents.length > limit;
    const items = hasMore ? documents.slice(0, limit) : documents;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1] as {
        _id: mongoose.Types.ObjectId;
        updatedAt?: Date | string;
      };
      const updatedAt =
        last.updatedAt instanceof Date
          ? last.updatedAt
          : last.updatedAt
            ? new Date(last.updatedAt)
            : serverTime;

      if (!Number.isNaN(updatedAt.getTime())) {
        nextCursor = encodeCursor(updatedAt, String(last._id));
      }
    }

    return NextResponse.json(
      {
        success: true,
        type,
        items,
        nextCursor,
        hasMore,
        serverTime: serverTime.toISOString(),
      },
      { headers: PRIVATE_REVALIDATE_HEADERS },
    );
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al generar el snapshot del catálogo:' });
  }
});
