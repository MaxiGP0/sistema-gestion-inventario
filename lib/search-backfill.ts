/**
 * Backfill idempotente y sincronización de índices de búsqueda.
 *
 * La lógica vive fuera del script para poder probarla contra MongoDB en
 * memoria. `backfillSearchFields()` sólo escribe los documentos cuyas claves
 * normalizadas cambiaron; una segunda ejecución devuelve `changed: 0`.
 *
 * Además de clientes, productos y marcas incluye pedidos: `searchTokens` cubre
 * cliente, vendedor, código corto e ítems, y `shortId` se completa desde `_id`
 * para que los pedidos históricos también se encuentren por `#xxxxxx`.
 *
 * Los productos reciben además los tokens del nombre de su marca, resuelto con
 * un mapa `_id -> name` cargado antes de recorrer la colección.
 */

import type { Model } from 'mongoose';
import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { orderShortId } from './order-short-id';
import {
  buildBrandSearchFields,
  buildClientSearchFields,
  buildOrderSearchFields,
  buildProductSearchFields,
  type SearchFieldValue,
} from './search-normalize';

type SearchDocument = Record<string, any>;
type SearchFieldValues = Record<string, SearchFieldValue>;

function searchValueMatches(current: unknown, next: SearchFieldValue): boolean {
  if (!Array.isArray(next)) return current === next;

  return (
    Array.isArray(current) &&
    current.length === next.length &&
    current.every((value, index) => value === next[index])
  );
}

/**
 * Pedidos históricos: además de los tokens se completa `shortId`, y la clave
 * incluye ese código para que `#xxxxxx` también encuentre documentos viejos.
 */
function buildOrderMigrationFields(document: SearchDocument): SearchFieldValues {
  const shortId = orderShortId(document._id);

  return {
    shortId,
    ...buildOrderSearchFields({ ...document, shortId }),
  };
}

export interface SearchMigrationContext {
  /** `_id` de marca -> nombre, para incluir la marca en Product.searchTokens. */
  brandNames?: ReadonlyMap<string, string>;
}

export interface CollectionSearchMigration {
  label: string;
  model: Model<any>;
  sourceFields: readonly string[];
  searchFields: readonly string[];
  compute: (document: SearchDocument, context: SearchMigrationContext) => SearchFieldValues;
}

export const SEARCH_MIGRATIONS: readonly CollectionSearchMigration[] = [
  {
    label: 'brands',
    model: Brand,
    sourceFields: ['name'],
    searchFields: ['searchName'],
    compute: buildBrandSearchFields,
  },
  {
    label: 'clients',
    model: Client,
    sourceFields: ['code', 'name', 'address', 'localidad', 'province'],
    searchFields: [
      'searchName',
      'searchCode',
      'searchLocalidad',
      'searchProvince',
      'searchAddress',
      'searchTokens',
    ],
    compute: buildClientSearchFields,
  },
  {
    label: 'products',
    model: Product,
    sourceFields: ['code', 'name', 'brandId'],
    searchFields: ['searchName', 'searchCode', 'searchTokens'],
    compute: (document, context) =>
      buildProductSearchFields({
        code: document.code,
        name: document.name,
        brandId: document.brandId,
        brandName: context.brandNames?.get(String(document.brandId)),
      }),
  },
  {
    label: 'orders',
    model: Order,
    sourceFields: ['clientName', 'clientCode', 'createdBy', 'items'],
    searchFields: ['shortId', 'searchTokens'],
    compute: buildOrderMigrationFields,
  },
];

export interface BackfillReport {
  label: string;
  scanned: number;
  changed: number;
}

export interface IndexSyncReport {
  label: string;
  before: string[];
  removed: string[];
  after: string[];
}

export interface BackfillOptions {
  dryRun?: boolean;
  batchSize?: number;
  migrations?: readonly CollectionSearchMigration[];
  /** Se llama al terminar cada colección (útil para logs del script). */
  onCollection?: (report: BackfillReport) => void;
}

/** Mapa liviano de marcas para no consultar `Brand` por cada producto. */
async function loadBrandNames(
  migrations: readonly CollectionSearchMigration[],
): Promise<Map<string, string>> {
  const brandNames = new Map<string, string>();
  if (!migrations.some((migration) => migration.label === 'products')) return brandNames;

  const brands = (await Brand.find({}, { name: 1 }).lean()) as unknown as Array<{
    _id: unknown;
    name?: string;
  }>;

  for (const brand of brands) {
    if (brand.name) brandNames.set(String(brand._id), String(brand.name));
  }

  return brandNames;
}

export async function backfillSearchFields({
  dryRun = false,
  batchSize = 500,
  migrations = SEARCH_MIGRATIONS,
  onCollection,
}: BackfillOptions = {}): Promise<BackfillReport[]> {
  const reports: BackfillReport[] = [];
  const context: SearchMigrationContext = {
    brandNames: await loadBrandNames(migrations),
  };

  for (const migration of migrations) {
    const { label, model, sourceFields, searchFields, compute } = migration;
    const projection = [...sourceFields, ...searchFields].join(' ');
    const cursor = model.find({}, projection).lean().cursor();

    let scanned = 0;
    let changed = 0;
    let operations: Record<string, unknown>[] = [];

    const flush = async () => {
      if (operations.length === 0 || dryRun) {
        operations = [];
        return;
      }
      await model.bulkWrite(operations as any, { ordered: false });
      operations = [];
    };

    for await (const document of cursor as AsyncIterable<SearchDocument>) {
      scanned += 1;
      const fields = compute(document, context);
      const needsUpdate = Object.entries(fields).some(
        ([key, value]) => !searchValueMatches(document[key], value),
      );

      if (needsUpdate) {
        changed += 1;
        operations.push({
          updateOne: {
            filter: { _id: document._id },
            update: { $set: fields },
          },
        });
      }

      if (operations.length >= batchSize) await flush();
    }

    await flush();
    const report = { label, scanned, changed };
    reports.push(report);
    onCollection?.(report);
  }

  return reports;
}

export async function listSearchIndexNames(model: Model<any>): Promise<string[]> {
  try {
    return (await model.collection.indexes())
      .map((index: { name?: string }) => index.name)
      .filter((name): name is string => Boolean(name));
  } catch (error) {
    // NamespaceNotFound: colección todavía inexistente.
    if ((error as { code?: number }).code === 26) return [];
    throw error;
  }
}

export async function syncSearchIndexes(
  migrations: readonly CollectionSearchMigration[] = SEARCH_MIGRATIONS,
): Promise<IndexSyncReport[]> {
  const reports: IndexSyncReport[] = [];

  for (const { label, model } of migrations) {
    const before = await listSearchIndexNames(model);
    const removed = await model.syncIndexes();
    const after = await listSearchIndexNames(model);
    reports.push({ label, before, removed, after });
  }

  return reports;
}
