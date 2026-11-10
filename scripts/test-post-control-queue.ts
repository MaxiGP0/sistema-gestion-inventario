/**
 * Pruebas de la cola serializada del control post-factura
 * (lib/post-control-queue.ts): un PATCH por vez, versión más reciente,
 * agrupación de toques rápidos y rollback sólo de las líneas que no tienen un
 * cambio posterior pendiente.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PostControlWriteQueue,
  type PostControlSyncUpdate,
  type PostControlWireUpdate,
} from '../lib/post-control-queue';
import {
  clearAllPostControlPending,
  clearPostControlPending,
  getPostControlPendingStorageKey,
  loadPostControlPending,
  mergePostControlPending,
  parsePostControlPending,
  POST_CONTROL_PENDING_STORAGE_KEY,
  POST_CONTROL_PENDING_TTL_MS,
  removePostControlPendingItems,
  savePostControlPending,
  type PostControlPendingSnapshot,
  type PostControlPendingStorage,
} from '../lib/post-control-autosave';

interface SentBatch {
  version: number;
  updates: PostControlWireUpdate[];
}

const change = (
  itemId: string,
  postControl: PostControlSyncUpdate['postControl'],
  previous: PostControlSyncUpdate['previous'],
): PostControlSyncUpdate => ({ itemId, postControl, previous });

/** Deja correr el microtask que agrupa los toques del mismo tick. */
const flushQueue = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('serializa los PATCH y usa la última versión recibida', async () => {
  let version = 0;
  let releaseFirst: (() => void) | null = null;
  const sent: SentBatch[] = [];

  const queue = new PostControlWriteQueue({
    getVersion: () => version,
    send: async (updates, currentVersion) => {
      sent.push({ version: currentVersion, updates });

      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }

      version = currentVersion + 1;
    },
  });

  queue.enqueue(change('linea-1', 'ok', 'pendiente'));
  await flushQueue();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].version, 0);

  // Estos dos toques llegan mientras el primero viaja: deben salir juntos y
  // con la versión que devolvió el primer PATCH.
  queue.enqueue(change('linea-2', 'ok', 'pendiente'));
  queue.enqueue(change('linea-3', 'diferencia', 'pendiente'));
  assert.equal(sent.length, 1);

  (releaseFirst as (() => void) | null)?.();
  await queue.whenIdle();

  assert.equal(sent.length, 2);
  assert.equal(sent[1].version, 1);
  assert.deepEqual(sent[1].updates, [
    { _id: 'linea-2', postControl: 'ok' },
    { _id: 'linea-3', postControl: 'diferencia' },
  ]);
});

test('une toques rápidos sobre la misma línea sin perder el valor previo', async () => {
  let version = 0;
  let releaseFirst: (() => void) | null = null;
  const sent: SentBatch[] = [];
  const failed: Array<readonly PostControlSyncUpdate[]> = [];

  const queue = new PostControlWriteQueue({
    getVersion: () => version,
    send: async (updates, currentVersion) => {
      sent.push({ version: currentVersion, updates });

      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        version = currentVersion + 1;
        return;
      }

      throw new Error('falló el segundo lote');
    },
    onError: (changes) => failed.push(changes),
  });

  queue.enqueue(change('linea-1', 'ok', 'pendiente'));
  await flushQueue();
  queue.enqueue(change('linea-1', 'diferencia', 'ok'));

  (releaseFirst as (() => void) | null)?.();
  await queue.whenIdle();

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].updates, [{ _id: 'linea-1', postControl: 'diferencia' }]);

  // El segundo lote falla y el rollback vuelve al valor anterior a TODOS los
  // toques ('pendiente'), no al intermedio ('ok').
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], [
    { itemId: 'linea-1', postControl: 'diferencia', previous: 'pendiente' },
  ]);
});

test('sólo revierte las líneas que no tienen un toque más nuevo pendiente', async () => {
  let version = 0;
  let attempt = 0;
  let releaseFirst: (() => void) | null = null;
  const failed: Array<readonly PostControlSyncUpdate[]> = [];

  const queue = new PostControlWriteQueue({
    getVersion: () => version,
    send: async (_updates, currentVersion) => {
      attempt += 1;

      if (attempt === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error('falló el primer lote');
      }

      version = currentVersion + 1;
    },
    onError: (changes) => failed.push(changes),
  });

  queue.enqueue(change('linea-1', 'ok', 'pendiente'));
  queue.enqueue(change('linea-2', 'ok', 'pendiente'));

  // Ambos toques del mismo tick salen en el lote 1.
  await flushQueue();

  // Mientras viaja el lote 1, la línea 1 recibe un valor más nuevo.
  queue.enqueue(change('linea-1', 'diferencia', 'ok'));

  (releaseFirst as (() => void) | null)?.();
  await queue.whenIdle();

  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], [{ itemId: 'linea-2', postControl: 'ok', previous: 'pendiente' }]);
});

test('dispose cancela los envíos pendientes', async () => {
  let version = 0;
  let releaseFirst: (() => void) | null = null;
  const sent: SentBatch[] = [];

  const queue = new PostControlWriteQueue({
    getVersion: () => version,
    send: async (updates, currentVersion) => {
      sent.push({ version: currentVersion, updates });
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      version = currentVersion + 1;
    },
  });

  queue.enqueue(change('linea-1', 'ok', 'pendiente'));
  queue.enqueue(change('linea-2', 'ok', 'pendiente'));
  await flushQueue();
  queue.dispose();
  (releaseFirst as (() => void) | null)?.();
  await queue.whenIdle();

  assert.equal(sent.length, 1);
  assert.equal(queue.size, 0);
});

/** Storage en memoria para probar el autosave del control post-factura. */
class MemoryStorage implements PostControlPendingStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const pendingSnapshot = (
  overrides: Partial<PostControlPendingSnapshot> = {},
): PostControlPendingSnapshot => ({
  orderId: 'pedido-1',
  userId: 'usuario-1',
  version: 4,
  savedAt: NOW - 60_000,
  items: { 'linea-1': 'ok', 'linea-2': 'diferencia' },
  previous: { 'linea-1': 'pendiente', 'linea-2': 'pendiente' },
  ...overrides,
});

test('el autosave post-factura guarda y recupera el lote por usuario y pedido', () => {
  const storage = new MemoryStorage();
  const saved = pendingSnapshot();

  assert.equal(savePostControlPending(storage, saved), true);
  assert.ok(storage.getItem(getPostControlPendingStorageKey('usuario-1', 'pedido-1')));
  assert.equal(POST_CONTROL_PENDING_STORAGE_KEY, 'sgi_post_control_pending');

  assert.deepEqual(
    loadPostControlPending(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      now: NOW,
    }),
    saved,
  );

  assert.equal(
    loadPostControlPending(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-2',
      now: NOW,
    }),
    null,
  );
});

test('mergePostControlPending une lotes y conserva el valor previo original', () => {
  const storage = new MemoryStorage();

  const first = mergePostControlPending(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 4,
    savedAt: NOW - 30_000,
    changes: [{ itemId: 'linea-1', postControl: 'ok', previous: 'pendiente' }],
  });

  assert.deepEqual(first?.items, { 'linea-1': 'ok' });
  assert.deepEqual(first?.previous, { 'linea-1': 'pendiente' });

  // Un segundo fallo sobre la misma línea conserva el previous del primer
  // toque, no el intermedio que ya estaba pintado.
  const second = mergePostControlPending(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 5,
    savedAt: NOW,
    changes: [{ itemId: 'linea-1', postControl: 'diferencia', previous: 'ok' }],
  });

  assert.deepEqual(second?.items, { 'linea-1': 'diferencia' });
  assert.deepEqual(second?.previous, { 'linea-1': 'pendiente' });
  assert.equal(second?.version, 5);
  assert.equal(second?.savedAt, NOW);

  // Volver al valor del servidor deja el lote vacío y borra la clave.
  const reverted = mergePostControlPending(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 6,
    savedAt: NOW,
    changes: [{ itemId: 'linea-1', postControl: 'pendiente', previous: 'diferencia' }],
  });

  assert.equal(reverted, null);
  assert.equal(storage.getItem(getPostControlPendingStorageKey('usuario-1', 'pedido-1')), null);
});

test('el autosave post-factura vence a las 24 h y tolera relojes adelantados', () => {
  const storage = new MemoryStorage();
  assert.equal(savePostControlPending(storage, pendingSnapshot()), true);

  const query = { orderId: 'pedido-1', userId: 'usuario-1' };

  assert.ok(
    loadPostControlPending(storage, {
      ...query,
      now: NOW - 60_000 + POST_CONTROL_PENDING_TTL_MS - 1,
    }),
  );
  assert.equal(
    loadPostControlPending(storage, {
      ...query,
      now: NOW - 60_000 + POST_CONTROL_PENDING_TTL_MS,
    }),
    null,
  );

  // Un adelanto de reloj de unos segundos no descarta el trabajo.
  assert.ok(loadPostControlPending(storage, { ...query, now: NOW - 30_000 }));
});

test('parsePostControlPending tolera datos corruptos y descarta controles inválidos', () => {
  assert.equal(parsePostControlPending(null), null);
  assert.equal(parsePostControlPending('{roto'), null);
  assert.equal(parsePostControlPending('[]'), null);
  assert.equal(
    parsePostControlPending(JSON.stringify({ ...pendingSnapshot(), items: {} })),
    null,
    'un lote sin líneas no sirve para reintentar',
  );

  const parsed = parsePostControlPending(
    JSON.stringify({
      orderId: ' pedido-1 ',
      userId: ' usuario-1 ',
      version: 3.9,
      savedAt: NOW,
      items: { ok: 'ok', dif: 'diferencia', invalido: 'otro', vacio: '' },
      previous: { ok: 'pendiente', dif: 'ok' },
    }),
  );

  assert.equal(parsed?.orderId, 'pedido-1');
  assert.equal(parsed?.userId, 'usuario-1');
  assert.equal(parsed?.version, 3);
  assert.deepEqual(parsed?.items, { ok: 'ok', dif: 'diferencia' });
  assert.deepEqual(parsed?.previous, { ok: 'pendiente', dif: 'ok' });
});

test('removePostControlPendingItems quita las líneas ya sincronizadas sin tocar el resto', () => {
  const storage = new MemoryStorage();
  assert.equal(savePostControlPending(storage, pendingSnapshot()), true);

  const remaining = removePostControlPendingItems(storage, 'usuario-1', 'pedido-1', ['linea-1'], {
    version: 5,
    savedAt: NOW,
  });

  assert.deepEqual(remaining?.items, { 'linea-2': 'diferencia' });
  assert.deepEqual(remaining?.previous, { 'linea-2': 'pendiente' });
  assert.equal(remaining?.version, 5);
  assert.equal(remaining?.savedAt, NOW);

  // Quitar una línea que no está en el snapshot no cambia nada.
  const untouched = removePostControlPendingItems(storage, 'usuario-1', 'pedido-1', ['linea-9']);
  assert.deepEqual(untouched?.items, remaining?.items);

  // Al quedar vacío se borra la clave para no reintentar nada viejo.
  assert.equal(removePostControlPendingItems(storage, 'usuario-1', 'pedido-1', ['linea-2']), null);
  assert.equal(storage.getItem(getPostControlPendingStorageKey('usuario-1', 'pedido-1')), null);
});

test('clearPostControlPending borra sólo el pedido indicado y clearAll limpia todo', () => {
  const storage = new MemoryStorage();
  assert.equal(savePostControlPending(storage, pendingSnapshot()), true);
  assert.equal(
    savePostControlPending(storage, pendingSnapshot({ userId: 'usuario-1', orderId: 'pedido-2' })),
    true,
  );
  assert.equal(
    savePostControlPending(storage, pendingSnapshot({ userId: 'usuario-2', orderId: 'pedido-1' })),
    true,
  );

  assert.equal(clearPostControlPending(storage, 'usuario-1', 'pedido-1'), true);
  assert.equal(
    loadPostControlPending(storage, { orderId: 'pedido-1', userId: 'usuario-1', now: NOW }),
    null,
  );
  assert.ok(
    loadPostControlPending(storage, { orderId: 'pedido-2', userId: 'usuario-1', now: NOW }),
  );

  assert.equal(clearAllPostControlPending(storage), 2);
  assert.equal(
    loadPostControlPending(storage, { orderId: 'pedido-2', userId: 'usuario-1', now: NOW }),
    null,
  );
});

test('un storage inaccesible no rompe el autosave post-factura', () => {
  const throwingStorage: PostControlPendingStorage = {
    getItem() {
      throw new Error('bloqueado');
    },
    setItem() {
      throw new Error('cuota');
    },
    removeItem() {
      throw new Error('bloqueado');
    },
  };

  assert.equal(savePostControlPending(throwingStorage, pendingSnapshot()), false);
  assert.equal(
    loadPostControlPending(throwingStorage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      now: NOW,
    }),
    null,
  );
  assert.equal(
    mergePostControlPending(throwingStorage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      version: 4,
      changes: [{ itemId: 'linea-1', postControl: 'ok', previous: 'pendiente' }],
    }),
    null,
  );
  assert.equal(clearPostControlPending(throwingStorage, 'usuario-1', 'pedido-1'), false);
  assert.equal(clearAllPostControlPending(throwingStorage), 0);

  assert.equal(savePostControlPending(null, pendingSnapshot()), false);
  assert.equal(
    loadPostControlPending(undefined, { orderId: 'pedido-1', userId: 'usuario-1' }),
    null,
  );
});
