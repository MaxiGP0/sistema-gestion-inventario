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
