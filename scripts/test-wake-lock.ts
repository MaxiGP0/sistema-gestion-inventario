/**
 * Pruebas del controlador que usa useWakeLock. El navegador se simula con un
 * `wakeLock.request('screen')` falso: no hace falta un DOM real ni esperar
 * eventos del sistema.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWakeLockController,
  readWakeLockPreference,
  WAKE_LOCK_STORAGE_KEY,
  writeWakeLockPreference,
  type WakeLockSentinelLike,
} from '../hooks/useWakeLock';

function createSentinel(): {
  sentinel: WakeLockSentinelLike;
  releaseCalls: () => number;
} {
  let released = false;
  let releases = 0;
  const listeners = new Set<() => void>();

  return {
    sentinel: {
      get released() {
        return released;
      },
      async release() {
        releases += 1;
        if (released) return;
        released = true;
        for (const listener of listeners) listener();
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
    },
    releaseCalls: () => releases,
  };
}

function createWakeLockMock(options: { rejectWith?: Error } = {}) {
  const requests: string[] = [];
  const sentinels: Array<ReturnType<typeof createSentinel>> = [];

  return {
    navigator: {
      wakeLock: {
        async request(type: 'screen') {
          requests.push(type);
          if (options.rejectWith) throw options.rejectWith;
          const entry = createSentinel();
          sentinels.push(entry);
          return entry.sentinel;
        },
      },
    },
    requests,
    sentinels,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test('pide el lock al activar después de una interacción', async () => {
  const mock = createWakeLockMock();
  const controller = createWakeLockController({ navigator: mock.navigator });

  // Todavía no hubo un toque: no se pide aunque la preferencia esté activa.
  controller.setEnabled(true);
  await flushPromises();
  assert.deepEqual(mock.requests, []);

  controller.markUserInteraction();
  await flushPromises();

  assert.deepEqual(mock.requests, ['screen']);
  assert.equal(controller.getState().active, true);
  assert.equal(controller.getState().supported, true);
});

test('libera al ocultar, re-pide al volver y libera al desmontar', async () => {
  const mock = createWakeLockMock();
  const controller = createWakeLockController({ navigator: mock.navigator });

  controller.markUserInteraction();
  controller.setEnabled(true);
  await flushPromises();
  assert.equal(mock.sentinels.length, 1);
  assert.equal(controller.getState().active, true);

  controller.handleVisibilityChange(true);
  assert.equal(mock.sentinels[0].releaseCalls(), 1);
  assert.equal(controller.getState().active, false);

  controller.handleVisibilityChange(false);
  await flushPromises();
  assert.equal(mock.sentinels.length, 2);
  assert.equal(controller.getState().active, true);

  controller.dispose();
  assert.equal(mock.sentinels[1].releaseCalls(), 1);
});

test('desactivar libera el lock y no lo vuelve a pedir sin interacción', async () => {
  const mock = createWakeLockMock();
  const controller = createWakeLockController({ navigator: mock.navigator });

  controller.markUserInteraction();
  controller.setEnabled(true);
  await flushPromises();

  controller.setEnabled(false);
  assert.equal(mock.sentinels[0].releaseCalls(), 1);
  assert.equal(controller.getState().active, false);

  await flushPromises();
  assert.equal(mock.requests.length, 1);
});

test('NotAllowedError se informa sin romper y sin dejar el lock activo', async () => {
  const error = new Error('Permission denied');
  error.name = 'NotAllowedError';
  const mock = createWakeLockMock({ rejectWith: error });
  const controller = createWakeLockController({ navigator: mock.navigator });

  assert.doesNotThrow(() => {
    controller.markUserInteraction();
    controller.setEnabled(true);
  });
  await flushPromises();

  assert.equal(controller.getState().active, false);
  assert.match(controller.getState().error ?? '', /no permitió/i);
});

test('sin Wake Lock disponible queda como no soportado sin lanzar', async () => {
  const controller = createWakeLockController({ navigator: {} });

  assert.doesNotThrow(() => {
    controller.markUserInteraction();
    controller.setEnabled(true);
  });
  await flushPromises();

  assert.equal(controller.getState().supported, false);
  assert.equal(controller.getState().active, false);
});

test('la preferencia se guarda en sgi_keep_awake', () => {
  const storage = createStorage();

  assert.equal(readWakeLockPreference(storage), false);
  writeWakeLockPreference(true, storage);
  assert.equal(storage.getItem(WAKE_LOCK_STORAGE_KEY), '1');
  assert.equal(readWakeLockPreference(storage), true);
  writeWakeLockPreference(false, storage);
  assert.equal(readWakeLockPreference(storage), false);
});
