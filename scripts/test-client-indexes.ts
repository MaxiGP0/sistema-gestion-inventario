/**
 * Pruebas del camino de búsqueda de Client y del destino de sus índices.
 *
 * GET /api/clients busca por prefijo (autocompletado con debounce) sobre las
 * claves normalizadas `searchName`, `searchCode`, `searchLocalidad`,
 * `searchProvince` y `searchAddress`, en minúsculas y sin acentos. El regex
 * anclado `/^termino/` puede resolverse con índices B-tree; el regex `i` no
 * anclado anterior obligaba a recorrer toda la colección y el countDocuments
 * terminaba en COLLSCAN.
 *
 * Los documentos históricos sin campos normalizados conservan el camino
 * anterior en una rama `$exists: false`. Después del backfill esa rama no
 * devuelve documentos, pero mantiene la compatibilidad durante el deploy.
 *
 * Sin base de datos: se stubbean Client.find/countDocuments para capturar la
 * consulta del route handler, y listIndexes/dropIndex/createIndex para los
 * escenarios de syncIndexes.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';

import { Client } from '../models/Client';
import { buildClientSearchFields, normalizeSearchText } from '../lib/search-normalize';
import { authRequest } from './test-auth-utils';

type IndexOptions = Record<string, unknown>;
type DbIndex = {
  v: number;
  key: Record<string, unknown>;
  name: string;
  unique?: boolean;
  weights?: Record<string, number>;
  textIndexVersion?: number;
};
type CreatedIndex = { key: Record<string, unknown>; options: IndexOptions };
type FindCapture = {
  query: Record<string, unknown>;
  select?: string;
  sort?: Record<string, 1 | -1>;
};
type CountCapture = { query: Record<string, unknown> };

/** Nombre del índice tal como lo deriva MongoDB de sus campos. */
const indexNameOf = (key: Record<string, unknown>) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');

const ID_INDEX: DbIndex = { v: 2, key: { _id: 1 }, name: '_id_' };
const CODE_INDEX: DbIndex = { v: 2, key: { code: 1 }, name: 'code_1', unique: true };
const LIST_INDEX: DbIndex = { v: 2, key: { name: 1, _id: 1 }, name: 'name_1__id_1' };
/** Compuesto text legacy, tal como lo expone listIndexes() en MongoDB. */
const LEGACY_SEARCH_INDEX: DbIndex = {
  v: 2,
  key: { _fts: 'text', _ftsx: 1 },
  name: 'name_text_code_1_localidad_1_province_1',
  weights: { name: 1, code: 1, localidad: 1, province: 1 },
  textIndexVersion: 3,
};

/** Campos normalizados declarados por el schema (en orden de declaración). */
const SEARCH_INDEX_KEYS = [
  { searchName: 1 },
  { searchCode: 1 },
  { searchLocalidad: 1 },
  { searchProvince: 1 },
  { searchAddress: 1 },
  { searchTokens: 1 },
];
const SNAPSHOT_INDEX_KEY = { updatedAt: 1, _id: 1 };

const prefixBranch = (field: string, normalizedTerm: string) => ({
  [field]: new RegExp(`^${normalizedTerm}`),
});
const fallbackBranch = (searchField: string, legacyField: string, term: string) => ({
  [searchField]: { $exists: false },
  [legacyField]: new RegExp(term, 'i'),
});

/** Capturas de Client.find()/countDocuments(): el route arma query/sort. */
const finds: FindCapture[] = [];
const counts: CountCapture[] = [];

let GET: (request: Request) => Promise<Response>;

const collection = (Client as any).collection as any;

/** Índices que la base simulada expone en `listIndexes()`. */
let dbIndexes: DbIndex[] = [];
/** Índices que `syncIndexes()` pidió crear (campos + opciones). */
let created: CreatedIndex[] = [];
/** Nombres que `syncIndexes()` pidió eliminar. */
let dropped: string[] = [];
/** Estado real de `buffer` para restaurarlo al terminar. */
let buffered = false;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Client as any, 'find', (query: Record<string, unknown>) => {
    const capture: FindCapture = { query };
    finds.push(capture);
    const chain: any = {
      select: (select: string) => {
        capture.select = select;
        return chain;
      },
      sort: (sort: Record<string, 1 | -1>) => {
        capture.sort = sort;
        return chain;
      },
      skip: () => chain,
      limit: () => chain,
      lean: async () => [],
    };
    return chain;
  });
  mock.method(Client as any, 'countDocuments', (query: Record<string, unknown>) => {
    counts.push({ query });
    return Promise.resolve(0);
  });

  ({ GET } = await import('../app/api/clients/route'));

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
    createIndex: async (key: Record<string, unknown>, options: IndexOptions) => {
      created.push({ key, options });
      return indexNameOf(key);
    },
  };
  for (const [method, implementation] of Object.entries(stubs)) {
    mock.method(collection, method, implementation);
  }
  // syncIndexes() crea la colección primero (autoCreate); se corta en la conexión.
  mock.method(Client.db, 'createCollection', async () => ({}));
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

const fetchClients = async (query = '') => {
  const previous = finds.length;
  const response = await GET(authRequest(`http://localhost/api/clients${query}`, {}, 'vendedor'));
  assert.equal(response.status, 200);
  assert.equal(finds.length, previous + 1, 'GET debe consultar Client.find()');
  return finds[finds.length - 1];
};

test('normaliza mayúsculas, acentos y espacios para todas las claves', () => {
  assert.equal(normalizeSearchText('  GÓMEZ   Núñez  '), 'gomez nunez');
  assert.equal(normalizeSearchText('DermaPlus'), 'dermaplus');
  assert.equal(normalizeSearchText('ÑANDÚ'), 'nandu');

  assert.deepEqual(
    buildClientSearchFields({
      code: 'C-Ñ1',
      name: 'José  María GÓMEZ',
      address: 'Av. Córdoba 123',
      localidad: 'Río Cuarto',
      province: 'Córdoba',
    }),
    {
      searchName: 'jose maria gomez',
      searchCode: 'c-n1',
      searchLocalidad: 'rio cuarto',
      searchProvince: 'cordoba',
      searchAddress: 'av. cordoba 123',
      searchTokens: ['c', 'n1', 'jose', 'maria', 'gomez', 'av', 'cordoba', '123', 'rio', 'cuarto'],
    },
  );
});

test('el schema declara los índices de prefijo y conserva el único de code y el de listado', () => {
  const declared = Client.schema.indexes().map(([key, options]) => ({
    key: key as Record<string, unknown>,
    options: options as IndexOptions,
  }));

  assert.deepEqual(
    declared.map(({ key }) => key),
    [{ code: 1 }, { name: 1, _id: 1 }, ...SEARCH_INDEX_KEYS, SNAPSHOT_INDEX_KEY],
    'debe haber un índice B-tree por cada campo normalizado y el del snapshot',
  );
  assert.equal(declared[0].options.unique, true, 'code debe seguir siendo único');
});

test('GET /api/clients?search= usa tokens anclados sobre el índice multikey', async () => {
  const find = await fetchClients('?search=Mod');
  const or = find.query.$or as Record<string, unknown>[];

  assert.equal(or.length, 2, 'rama indexada de tokens + fallback histórico');
  assert.deepEqual(or[0], { searchTokens: { $all: [/^mod/] } });

  const historical = or[1] as any;
  assert.deepEqual(historical.searchTokens, { $exists: false });
  const historicalOr = historical.$and[0].$or as Record<string, unknown>[];

  assert.deepEqual(historicalOr[0], prefixBranch('searchName', 'mod'));
  assert.deepEqual(historicalOr[1], prefixBranch('searchCode', 'mod'));
  assert.deepEqual(historicalOr[2], prefixBranch('searchLocalidad', 'mod'));
  assert.deepEqual(historicalOr[3], prefixBranch('searchProvince', 'mod'));
  assert.deepEqual(historicalOr[4], prefixBranch('searchAddress', 'mod'));
  assert.deepEqual(historicalOr[5], fallbackBranch('searchName', 'name', 'Mod'));
  assert.deepEqual(historicalOr[6], fallbackBranch('searchCode', 'code', 'Mod'));
  assert.deepEqual(historicalOr[7], fallbackBranch('searchLocalidad', 'localidad', 'Mod'));

  for (const branch of (or[0] as any).searchTokens.$all as RegExp[]) {
    assert.ok(branch.source.startsWith('^'), 'la rama indexada debe estar anclada al prefijo');
    assert.equal(branch.flags, '', 'la clave normalizada ya está en minúsculas');
  }

  assert.deepEqual(
    find.sort,
    { name: 1, _id: 1 },
    'el listado se ordena por name y desempata por _id',
  );
  assert.equal(
    find.select,
    'code name address localidad province generalDiscount brandDiscounts',
    'el listado no debe traer createdAt/updatedAt/__v',
  );
  assert.deepEqual(
    counts[counts.length - 1].query,
    find.query,
    'el conteo debe usar la misma consulta indexada',
  );
});

test('GET /api/clients?search= exige todos los tokens en cualquier posición', async () => {
  const find = await fetchClients(`?search=${encodeURIComponent('super ahorro')}`);
  const indexed = (find.query.$or as any[])[0];

  assert.deepEqual(indexed.searchTokens.$all, [/^super/, /^ahorro/]);
  assert.equal((find.query.$or as any[])[1].$and.length, 2, 'un $and por token histórico');
});

test('acentos y mayúsculas producen la misma clave de prefijo', async () => {
  const accented = await fetchClients(`?search=${encodeURIComponent('GÓMEZ')}`);
  const lower = await fetchClients(`?search=${encodeURIComponent('gómez')}`);

  const accentedOr = accented.query.$or as any[];
  const lowerOr = lower.query.$or as any[];
  assert.deepEqual(
    accentedOr[0],
    lowerOr[0],
    'mayúsculas y minúsculas producen las mismas ramas indexadas',
  );
  assert.deepEqual(accentedOr[0], { searchTokens: { $all: [/^gomez/] } });
  const historicalOr = accentedOr[1].$and[0].$or as any[];
  assert.deepEqual(historicalOr[0], prefixBranch('searchName', 'gomez'));
  assert.deepEqual(historicalOr[5], fallbackBranch('searchName', 'name', 'GÓMEZ'));
  for (const index of [5, 6, 7, 8, 9]) {
    assert.equal((historicalOr[index] as any)[Object.keys(historicalOr[index])[1]].flags, 'i');
  }

  const nandu = await fetchClients(`?search=${encodeURIComponent('ÑANDÚ')}`);
  assert.deepEqual((nandu.query.$or as any[])[0], {
    searchTokens: { $all: [/^nandu/] },
  });
});

test('q es alias de search y el término se escapa antes de armar el regex', async () => {
  const find = await fetchClients(`?q=${encodeURIComponent('C-1.0')}`);
  const indexed = (find.query.$or as any[])[0];

  assert.deepEqual(indexed, { searchTokens: { $all: [/^c/, /^1/, /^0/] } });
  const historicalOr = (find.query.$or as any[])[1].$and[0].$or as any[];
  assert.deepEqual(historicalOr[0], { searchName: new RegExp('^c') });
  assert.deepEqual(historicalOr[1], { searchCode: new RegExp('^c') });
  const historicalFallback = (find.query.$or as any[])[1].$and[0].$or as any[];
  assert.deepEqual(historicalFallback[5], {
    searchName: { $exists: false },
    name: new RegExp('C', 'i'),
  });
});

test('sin término no agrega filtro de búsqueda', async () => {
  const find = await fetchClients('?search=%20%20');
  assert.deepEqual(find.query, {});
});

test('syncIndexes() elimina el compuesto legacy y crea los índices de prefijo', async () => {
  // Escenario de producción: la colección todavía conserva el índice viejo y
  // no tiene los índices nuevos.
  resetCaptures([ID_INDEX, CODE_INDEX, LIST_INDEX, LEGACY_SEARCH_INDEX]);

  const removed = await Client.syncIndexes();

  assert.deepEqual(
    dropped,
    ['name_text_code_1_localidad_1_province_1'],
    'syncIndexes() debe eliminar el compuesto legacy',
  );
  assert.deepEqual(removed, ['name_text_code_1_localidad_1_province_1']);
  assert.deepEqual(
    created.map((index) => index.key),
    [...SEARCH_INDEX_KEYS, SNAPSHOT_INDEX_KEY],
    'debe crear un índice por campo normalizado y el del snapshot',
  );
});

test('con todos los índices, syncIndexes() no pide crear ni eliminar nada', async () => {
  resetCaptures([
    ID_INDEX,
    CODE_INDEX,
    LIST_INDEX,
    ...[...SEARCH_INDEX_KEYS, SNAPSHOT_INDEX_KEY].map((key) => ({
      v: 2,
      key,
      name: indexNameOf(key),
    })),
  ]);

  const { toCreate, toDrop } = await Client.diffIndexes();
  assert.deepEqual(toCreate, []);
  assert.deepEqual(toDrop, []);

  const removed = await Client.syncIndexes();
  assert.deepEqual(removed, []);
  assert.deepEqual(dropped, []);
  assert.deepEqual(created, []);
});
