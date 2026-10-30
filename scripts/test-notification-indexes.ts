/**
 * Pruebas de los índices de Notification para los listados de /api/notifications.
 *
 * GET /api/notifications ordena por `{ createdAt: -1, _id: -1 }`, con o sin
 * filtro por targetRole (el rol propio + las globales). Sin índices, el planner
 * resuelve ese orden con un collection scan más sort en memoria. El schema
 * declara:
 *   - { targetRole: 1, createdAt: -1, _id: -1 }: filtro por targetRole + orden.
 *   - { createdAt: -1, _id: -1 }: listado global sin filtro.
 *   - { createdAt: 1 } TTL: retención de 180 días.
 *
 * No requiere base de datos: se stubbea Notification.aggregate para capturar
 * el pipeline que arma el route handler real y se verifica contra los índices
 * declarados en el schema (filtro por prefijo + orden a continuación) que cada
 * forma quede cubierta por un único índice.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';

import { Notification, NOTIFICATION_RETENTION_SECONDS } from '../models/Notification';
import { authRequest } from './test-auth-utils';

type IndexKey = Record<string, number>;
type SortSpec = Record<string, 1 | -1>;
type AggregateCapture = { pipeline: any[] };

/** Índices declarados en el schema, tal como los ve syncIndexes()/MongoDB. */
const schemaIndexes = (): { key: IndexKey; name?: string; options: Record<string, unknown> }[] =>
  Notification.schema.indexes().map(([key, options]) => ({
    key: key as IndexKey,
    name: (options as { name?: string })?.name,
    options: (options ?? {}) as Record<string, unknown>,
  }));

/** Nombre del índice tal como lo deriva MongoDB de sus campos. */
const indexNameOf = (key: IndexKey) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');

/** Predicado de filtro que el índice resuelve por prefijo: igualdad o $in. */
const isBoundPredicate = (value: unknown) =>
  value !== undefined &&
  (typeof value !== 'object' ||
    value === null ||
    '$in' in (value as object) ||
    '$eq' in (value as object));

/**
 * Índices que pueden resolver el listado sin collection scan:
 * - todos los predicados de filtro caen en el prefijo del índice, y
 * - el orden continúa ese prefijo en el mismo orden y dirección.
 */
const coveringIndexes = (query: Record<string, unknown>, sort: SortSpec): string[] =>
  schemaIndexes()
    .filter(({ key, options }) => {
      // El TTL no participa del orden estable (no incluye _id).
      if (options.expireAfterSeconds !== undefined) return false;

      const fields = Object.keys(key);
      const boundFields = Object.keys(query).filter((field) => isBoundPredicate(query[field]));
      const bound = fields.findIndex((field) => !boundFields.includes(field));
      const prefixLength = bound === -1 ? fields.length : bound;

      const sortFields = Object.keys(sort);
      return (
        boundFields.length <= prefixLength &&
        sortFields.length > 0 &&
        sortFields.every(
          (field, offset) => fields[prefixLength + offset] === field && key[field] === sort[field],
        )
      );
    })
    .map(({ key }) => indexNameOf(key));

/** Capturas de Notification.aggregate(): el route arma pipeline por cadena. */
const aggregates: AggregateCapture[] = [];

let GET: (request: Request) => Promise<Response>;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Notification as any, 'aggregate', (pipeline: any[]) => {
    aggregates.push({ pipeline });
    return Promise.resolve([]);
  });

  ({ GET } = await import('../app/api/notifications/route'));
});

after(() => mock.restoreAll());

const fetchNotifications = async (
  query = '',
): Promise<{ pipeline: any[]; match: Record<string, unknown>; sort: SortSpec }> => {
  const before = aggregates.length;
  const response = await GET(authRequest(`http://localhost/api/notifications${query}`));
  assert.equal(response.status, 200);
  assert.equal(aggregates.length, before + 1, 'GET debe consultar Notification.aggregate()');

  const pipeline = aggregates[aggregates.length - 1].pipeline;
  const match = pipeline.find((stage) => stage.$match)?.$match;
  const sort = pipeline.find((stage) => stage.$sort)?.$sort;
  return { pipeline, match, sort };
};

test('el schema declara los índices de cursor y el TTL de retención', () => {
  const indexes = schemaIndexes();
  const names = indexes.map(({ key, name }) => name ?? indexNameOf(key)).sort();

  assert.deepEqual(names, [
    'createdAt_-1__id_-1',
    'notification_retention_ttl',
    'targetRole_1_createdAt_-1__id_-1',
    'targetRole_1_targetUserId_1_createdAt_-1__id_-1',
  ]);
  assert.equal(
    indexes.find(({ name }) => name === 'notification_retention_ttl')?.options.expireAfterSeconds,
    NOTIFICATION_RETENTION_SECONDS,
  );
  assert.equal(NOTIFICATION_RETENTION_SECONDS, 180 * 24 * 60 * 60);
});

test('el índice privado del vendedor cubre destinatario y orden del cursor', () => {
  const index = schemaIndexes().find(
    ({ key }) =>
      (key as any).targetRole === 1 &&
      (key as any).targetUserId === 1 &&
      (key as any).createdAt === -1 &&
      (key as any)._id === -1,
  );

  assert.ok(index, 'debe existir { targetRole, targetUserId, createdAt, _id }');
});

test('el listado global (sin targetRole) lo cubre sólo el índice createdAt/_id', async () => {
  const { match, sort } = await fetchNotifications();

  assert.deepEqual(match, {}, 'sin filtro el listado es global');
  assert.deepEqual(sort, { createdAt: -1, _id: -1 });
  assert.deepEqual(coveringIndexes(match, sort!), ['createdAt_-1__id_-1']);
});

test('el listado por targetRole lo cubre sólo el compuesto targetRole+createdAt+_id', async () => {
  const { match, sort } = await fetchNotifications('?targetRole=deposit');

  assert.deepEqual(match, { targetRole: { $in: ['deposit', 'all'] } });
  assert.deepEqual(sort, { createdAt: -1, _id: -1 });
  assert.deepEqual(coveringIndexes(match, sort!), ['targetRole_1_createdAt_-1__id_-1']);
});

test('targetRole=all es el listado global y lo cubre el índice createdAt/_id', async () => {
  const { match, sort } = await fetchNotifications('?targetRole=all');

  assert.deepEqual(match, {}, 'para all no se filtra por rol');
  assert.deepEqual(sort, { createdAt: -1, _id: -1 });
  assert.deepEqual(coveringIndexes(match, sort!), ['createdAt_-1__id_-1']);
});

test('el índice simple no alcanza para el filtro y el compuesto no para el global', () => {
  // El compuesto exige targetRole como prefijo: no puede ordenar por createdAt sin filtro.
  assert.deepEqual(coveringIndexes({}, { createdAt: -1, _id: -1 }), ['createdAt_-1__id_-1']);
  // El simple ordena por createdAt pero no acota el filtro por targetRole.
  assert.deepEqual(
    coveringIndexes({ targetRole: { $in: ['billing', 'all'] } }, { createdAt: -1, _id: -1 }),
    ['targetRole_1_createdAt_-1__id_-1'],
  );
});
