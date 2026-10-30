/**
 * Pruebas de los índices de Order: listado por cursor, código corto y búsqueda.
 *
 * La búsqueda de pedidos dejó de depender del índice `$text`
 * `order_search_text` (MongoDB no soporta prefijos con `*`) y ahora usa el
 * multikey `searchTokens` dentro del compuesto
 * `{ archived: 1, searchTokens: 1, createdAt: -1, _id: -1 }`.
 *
 * También se verifica que `archived` no declare índice propio y que
 * `syncIndexes()` elimine los índices legacy, incluido el de texto.
 *
 * No requiere base de datos: se interceptan `listIndexes`, `dropIndex` y
 * `createIndex` de la colección de Mongoose (la frontera por la que pasa
 * `Model.syncIndexes()`) y se la alimenta con una lista de índices simulada.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';

import { Order } from '../models/Order';

type IndexKey = Record<string, number | string>;
type DbIndex = {
  v: number;
  key: IndexKey;
  name: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  weights?: Record<string, number>;
  default_language?: string;
  language_override?: string;
  textIndexVersion?: number;
};
type CreatedIndex = { key: IndexKey; options: Record<string, unknown> };

/** Nombre del índice tal como lo deriva MongoDB de sus campos. */
const indexNameOf = (key: IndexKey) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');

/** Índice de la base como lo devuelve `listIndexes()`. */
const dbIndex = (key: IndexKey): DbIndex => ({ v: 2, key, name: indexNameOf(key) });

const ID_INDEX = dbIndex({ _id: 1 });
const COMPOUND_ARCHIVED_INDEX = dbIndex({ archived: 1, status: 1, createdAt: -1, _id: -1 });
const LEGACY_ARCHIVED_INDEX = dbIndex({ archived: 1 });
const SEARCH_TOKENS_INDEX = dbIndex({ archived: 1, searchTokens: 1, createdAt: -1, _id: -1 });
/** Índice de texto legacy tal como lo expone listIndexes() en MongoDB. */
const TEXT_SEARCH_INDEX: DbIndex = {
  v: 2,
  key: { _fts: 'text', _ftsx: 1 },
  name: 'order_search_text',
  weights: { clientName: 1, clientCode: 1, createdBy: 1 },
  default_language: 'spanish',
  language_override: 'language',
  textIndexVersion: 3,
};
const DUPLICATE_REQUEST_INDEX: DbIndex = {
  ...dbIndex({ createdById: 1, clientRequestId: 1 }),
  unique: true,
  partialFilterExpression: { clientRequestId: { $type: 'string' } },
};
const REST_OF_SCHEMA_INDEXES = [
  dbIndex({ status: 1, createdAt: -1, _id: -1 }),
  dbIndex({ clientId: 1, createdAt: -1, _id: -1 }),
  dbIndex({ createdById: 1, createdAt: -1, _id: -1 }),
  DUPLICATE_REQUEST_INDEX,
  dbIndex({ archived: 1, createdAt: -1, _id: -1 }),
  dbIndex({ createdAt: -1, _id: -1 }),
  dbIndex({ 'items.productId': 1 }),
  dbIndex({ shortId: 1 }),
  SEARCH_TOKENS_INDEX,
];

const collection = (Order as any).collection as any;

/** Índices que la base simulada expone en `listIndexes()`. */
let dbIndexes: DbIndex[] = [];
/** Índices que `syncIndexes()` pidió crear (campos + opciones). */
let created: CreatedIndex[] = [];
/** Nombres que `syncIndexes()` pidió eliminar. */
let dropped: string[] = [];
/** Estado real de `buffer` para restaurarlo al terminar. */
let buffered = false;

before(() => {
  buffered = collection.buffer;
  // Simula una conexión abierta: con `buffer` en true, listIndexes() esperaría
  // la apertura antes de consultar (y sin base no llegaría nunca).
  collection.buffer = false;

  const stubs = {
    listIndexes: () => ({ toArray: async () => dbIndexes }),
    dropIndex: async (name: string) => {
      dropped.push(name);
      return { ok: 1 };
    },
    createIndex: async (key: IndexKey, options: Record<string, unknown>) => {
      created.push({ key, options });
      return indexNameOf(key);
    },
  };
  for (const [method, implementation] of Object.entries(stubs)) {
    mock.method(collection, method, implementation);
  }
  // syncIndexes() crea la colección primero (autoCreate); se corta en la conexión.
  mock.method(Order.db, 'createCollection', async () => ({}));
});

after(() => {
  mock.restoreAll();
  collection.buffer = buffered;
});

const resetCaptures = (indexes: DbIndex[]) => {
  dbIndexes = indexes;
  created = [];
  dropped = [];
};

test('el schema mantiene el compuesto de archived, no declara archived_1 y usa searchTokens en lugar del índice de texto', () => {
  const specs = Order.schema.indexes();
  const keys = specs.map(([key]) => key as IndexKey);

  assert.ok(
    keys.some((key) => {
      const fields = Object.keys(key);
      return (
        fields.length === 4 &&
        key.archived === 1 &&
        key.status === 1 &&
        key.createdAt === -1 &&
        key._id === -1
      );
    }),
    'debe existir el compuesto { archived: 1, status: 1, createdAt: -1, _id: -1 }',
  );
  assert.ok(
    keys.filter((key) => key.createdAt === -1).every((key) => key._id === -1),
    'todos los índices de listado deben incluir _id para el orden del cursor',
  );
  assert.ok(
    keys.some((key) => {
      const fields = Object.keys(key);
      return fields.length === 3 && key.archived === 1 && key.createdAt === -1 && key._id === -1;
    }),
    'debe existir el compuesto { archived: 1, createdAt: -1, _id: -1 } para archivado + fecha sin estado',
  );
  assert.ok(
    !keys.some((key) => Object.keys(key).length === 1 && key.archived === 1),
    'archived no debe declarar un índice de un solo campo: lo cubre el compuesto por prefijo',
  );
  assert.ok(
    keys.some((key) => {
      const fields = Object.keys(key);
      return fields.length === 3 && key.createdById === 1 && key.createdAt === -1 && key._id === -1;
    }),
    'debe existir { createdById: 1, createdAt: -1, _id: -1 } para "Mis pedidos"',
  );

  const searchIndex = specs.find(([key]) => key.archived === 1 && key.searchTokens === 1);
  assert.ok(searchIndex, 'debe existir el índice multikey de búsqueda de pedidos');
  assert.equal(searchIndex![0].createdAt, -1, 'el índice debe ordenar por createdAt');
  assert.equal(searchIndex![0]._id, -1, 'el índice debe desempatar por _id');
  assert.ok(
    !keys.some((key) => key.clientName === 'text'),
    'el índice $text order_search_text ya no debe declararse',
  );
  assert.ok(
    keys.some((key) => Object.keys(key).length === 1 && key.shortId === 1),
    'debe existir { shortId: 1 } para buscar por #xxxxxx',
  );
});

test('syncIndexes() no pide crear archived_1 si la base ya no lo tiene', async () => {
  // Escenario post-migración: archived_1 ya no existe y falta un índice legítimo.
  resetCaptures([
    ID_INDEX,
    COMPOUND_ARCHIVED_INDEX,
    ...REST_OF_SCHEMA_INDEXES.filter((index) => index.name !== 'createdAt_-1__id_-1'),
  ]);

  const { toCreate } = await Order.diffIndexes();
  assert.ok(
    !toCreate.some((key) => indexNameOf(key) === 'archived_1'),
    'diffIndexes() (el dry-run de syncIndexes) no debe listar archived_1 para crear',
  );

  await Order.syncIndexes();

  assert.deepEqual(dropped, [], 'no hay índices extra que eliminar');
  assert.ok(
    !created.some((index) => indexNameOf(index.key) === 'archived_1'),
    'syncIndexes() no debe reintentar crear archived_1',
  );
  assert.deepEqual(
    created.map((index) => index.key),
    [{ createdAt: -1, _id: -1 }],
    'sólo debe crear el índice legítimo que faltaba',
  );
});

test('syncIndexes() elimina los índices legacy archived_1 y order_search_text', async () => {
  // Escenario de producción: la colección todavía conserva ambos índices viejos.
  resetCaptures([
    ID_INDEX,
    LEGACY_ARCHIVED_INDEX,
    COMPOUND_ARCHIVED_INDEX,
    ...REST_OF_SCHEMA_INDEXES,
    TEXT_SEARCH_INDEX,
  ]);

  const removed = await Order.syncIndexes();

  assert.deepEqual(
    [...dropped].sort(),
    ['archived_1', 'order_search_text'],
    'syncIndexes() debe eliminar ambos índices legacy',
  );
  assert.deepEqual(removed.sort(), ['archived_1', 'order_search_text']);
  assert.ok(
    !created.some((index) => indexNameOf(index.key) === 'archived_1'),
    'syncIndexes() no debe reintentar crear archived_1',
  );
  assert.deepEqual(created, [], 'no queda nada legítimo por crear');
});

test('syncIndexes() reemplaza los índices de listado sin _id por los del cursor', async () => {
  const legacyIndexes = [
    dbIndex({ archived: 1, status: 1, createdAt: -1 }),
    dbIndex({ status: 1, createdAt: -1 }),
    dbIndex({ clientId: 1, createdAt: -1 }),
    dbIndex({ createdAt: -1 }),
  ];

  resetCaptures([
    ID_INDEX,
    ...legacyIndexes,
    DUPLICATE_REQUEST_INDEX,
    dbIndex({ 'items.productId': 1 }),
    dbIndex({ shortId: 1 }),
    TEXT_SEARCH_INDEX,
  ]);

  const removed = await Order.syncIndexes();

  const expectedCreatedIndexes: IndexKey[] = [
    { archived: 1, status: 1, createdAt: -1, _id: -1 },
    { status: 1, createdAt: -1, _id: -1 },
    { clientId: 1, createdAt: -1, _id: -1 },
    { createdById: 1, createdAt: -1, _id: -1 },
    { archived: 1, createdAt: -1, _id: -1 },
    { createdAt: -1, _id: -1 },
    { archived: 1, searchTokens: 1, createdAt: -1, _id: -1 },
  ];

  assert.deepEqual(
    [...removed].sort(),
    [...legacyIndexes.map((index) => index.name), 'order_search_text'].sort(),
    'debe eliminar los índices viejos y el índice de texto reemplazado por searchTokens',
  );
  assert.deepEqual(
    created.map((index) => indexNameOf(index.key)).sort(),
    expectedCreatedIndexes.map((key) => indexNameOf(key)).sort(),
    'debe crear los índices equivalentes con _id y el multikey de búsqueda',
  );
});
