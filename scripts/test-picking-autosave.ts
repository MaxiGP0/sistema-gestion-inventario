/**
 * Pruebas del autosave local del picking (lib/picking-autosave.ts):
 * persistencia por usuario/pedido, TTL de 24 h, validación de versión,
 * saneamiento de datos corruptos y protección contra pisar un pedido más nuevo.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearPickingAutosave,
  clearPickingAutosaveComment,
  getPickingAutosaveStorageKey,
  loadPickingAutosave,
  parsePickingAutosave,
  PICKING_AUTOSAVE_STORAGE_KEY,
  PICKING_AUTOSAVE_TTL_MS,
  savePickingAutosave,
  type PickingAutosaveSnapshot,
  type PickingAutosaveStorage,
} from '../lib/picking-autosave';

class MemoryStorage implements PickingAutosaveStorage {
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

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

const snapshot = (overrides: Partial<PickingAutosaveSnapshot> = {}): PickingAutosaveSnapshot => ({
  orderId: 'pedido-1',
  userId: 'usuario-1',
  version: 3,
  savedAt: NOW - 60_000,
  items: {
    'linea-1': { verifiedQty: 5, controlled: true, pendingReason: '' },
    'linea-2': { verifiedQty: 0, controlled: false, pendingReason: 'Sin stock' },
  },
  ...overrides,
});

test('save/load devuelve el snapshot del mismo usuario, pedido y versión', () => {
  const storage = new MemoryStorage();
  const saved = snapshot();

  assert.equal(savePickingAutosave(storage, saved), true);
  assert.ok(storage.getItem(getPickingAutosaveStorageKey('usuario-1', 'pedido-1')));
  assert.equal(PICKING_AUTOSAVE_STORAGE_KEY, 'sgi_picking_autosave');

  assert.deepEqual(
    loadPickingAutosave(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      version: 3,
      now: NOW,
    }),
    saved,
  );
});

test('el autosave no se restaura en otro usuario, otro pedido u otra versión', () => {
  const storage = new MemoryStorage();
  assert.equal(savePickingAutosave(storage, snapshot()), true);

  assert.equal(
    loadPickingAutosave(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-2',
      version: 3,
      now: NOW,
    }),
    null,
  );
  assert.equal(
    loadPickingAutosave(storage, {
      orderId: 'pedido-2',
      userId: 'usuario-1',
      version: 3,
      now: NOW,
    }),
    null,
  );
  // Otra versión significa que el pedido cambió: restaurar pisaría ese cambio.
  assert.equal(
    loadPickingAutosave(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      version: 4,
      now: NOW,
    }),
    null,
  );
});

test('el snapshot vence a las 24 h y rechaza fechas futuras absurdas', () => {
  const storage = new MemoryStorage();
  assert.equal(savePickingAutosave(storage, snapshot()), true);

  const query = { orderId: 'pedido-1', userId: 'usuario-1', version: 3 };

  assert.ok(
    loadPickingAutosave(storage, {
      ...query,
      now: NOW - 60_000 + PICKING_AUTOSAVE_TTL_MS - 1,
    }),
  );
  assert.equal(
    loadPickingAutosave(storage, {
      ...query,
      now: NOW - 60_000 + PICKING_AUTOSAVE_TTL_MS,
    }),
    null,
  );

  assert.equal(
    loadPickingAutosave(storage, {
      ...query,
      now: NOW - 5 * 60_000,
    }),
    null,
  );
  // Unos segundos de adelanto por cambio de reloj sí se toleran.
  assert.ok(loadPickingAutosave(storage, { ...query, now: NOW - 30_000 }));
});

test('savePickingAutosave no pisa un snapshot de una versión más nueva', () => {
  const storage = new MemoryStorage();
  const newer = snapshot({
    version: 7,
    items: { 'linea-1': { verifiedQty: 9, controlled: true, pendingReason: '' } },
  });
  assert.equal(savePickingAutosave(storage, newer), true);

  const older = snapshot({
    version: 6,
    items: { 'linea-1': { verifiedQty: 1, controlled: true, pendingReason: '' } },
  });
  assert.equal(savePickingAutosave(storage, older), false);

  const kept = loadPickingAutosave(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 7,
    now: NOW,
  });
  assert.equal(kept?.items['linea-1'].verifiedQty, 9);

  // Una versión posterior sí reemplaza al snapshot anterior.
  const updated = snapshot({
    version: 8,
    items: { 'linea-1': { verifiedQty: 2, controlled: true, pendingReason: '' } },
  });
  assert.equal(savePickingAutosave(storage, updated), true);
  const latest = loadPickingAutosave(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 8,
    now: NOW,
  });
  assert.equal(latest?.items['linea-1'].verifiedQty, 2);
});

test('parsePickingAutosave tolera JSON roto y sanea entradas inválidas', () => {
  assert.equal(parsePickingAutosave(null), null);
  assert.equal(parsePickingAutosave(''), null);
  assert.equal(parsePickingAutosave('{roto'), null);
  assert.equal(parsePickingAutosave('[]'), null);
  assert.equal(parsePickingAutosave('"texto"'), null);
  assert.equal(parsePickingAutosave('{}'), null);
  assert.equal(
    parsePickingAutosave(JSON.stringify({ ...snapshot(), items: {} })),
    null,
    'un snapshot sin líneas no sirve para restaurar',
  );

  const parsed = parsePickingAutosave(
    JSON.stringify({
      orderId: ' pedido-1 ',
      userId: ' usuario-1 ',
      version: 2.9,
      savedAt: NOW,
      items: {
        ok: { verifiedQty: 4.8, controlled: true, pendingReason: 'x'.repeat(300) },
        negativa: { verifiedQty: -1, controlled: false, pendingReason: '' },
        texto: { verifiedQty: '3', controlled: false, pendingReason: '' },
        sinControl: { verifiedQty: 1, pendingReason: '' },
        noObjeto: 42,
      },
    }),
  );

  assert.equal(parsed?.orderId, 'pedido-1');
  assert.equal(parsed?.userId, 'usuario-1');
  assert.equal(parsed?.version, 2);
  assert.deepEqual(parsed?.items.ok, {
    verifiedQty: 4,
    controlled: true,
    pendingReason: 'x'.repeat(200),
  });
  assert.equal(parsed?.items.negativa, undefined);
  assert.equal(parsed?.items.texto, undefined);
  assert.equal(parsed?.items.sinControl, undefined);
  assert.equal(parsed?.items.noObjeto, undefined);
});

test('el snapshot conserva un comentario pendiente aunque no tenga líneas', () => {
  const storage = new MemoryStorage();
  const saved = snapshot({
    items: {},
    pendingComment: '  Falta stock del proveedor  ',
  });

  assert.equal(savePickingAutosave(storage, saved), true);

  const loaded = loadPickingAutosave(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 3,
    now: NOW,
  });

  assert.equal(loaded?.pendingComment, 'Falta stock del proveedor');
  assert.deepEqual(loaded?.items, {});
});

test('clearPickingAutosaveComment quita sólo el comentario y conserva el picking', () => {
  const storage = new MemoryStorage();
  assert.equal(
    savePickingAutosave(
      storage,
      snapshot({
        pendingComment: 'Comentario sin red',
      }),
    ),
    true,
  );

  assert.equal(clearPickingAutosaveComment(storage, 'usuario-1', 'pedido-1'), true);

  const loaded = loadPickingAutosave(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: 3,
    now: NOW,
  });
  assert.equal(loaded?.pendingComment, undefined);
  assert.deepEqual(loaded?.items, snapshot().items);
  assert.equal(clearPickingAutosaveComment(storage, 'usuario-1', 'pedido-1'), false);
});

test('un comentario pendiente solo se elimina del storage al limpiarlo', () => {
  const storage = new MemoryStorage();
  assert.equal(
    savePickingAutosave(storage, snapshot({ items: {}, pendingComment: 'Sólo comentario' })),
    true,
  );

  assert.equal(clearPickingAutosaveComment(storage, 'usuario-1', 'pedido-1'), true);
  assert.equal(storage.getItem(getPickingAutosaveStorageKey('usuario-1', 'pedido-1')), null);
});

test('al sincronizar un comentario el snapshot se reasocia a la versión nueva sin perder líneas', () => {
  const storage = new MemoryStorage();
  const original = snapshot({ pendingComment: 'Comentario sin red' });

  assert.equal(savePickingAutosave(storage, original), true);

  // Lo que hace el detalle de depósito cuando el PUT del comentario devuelve
  // la versión siguiente: reescribe el mismo picking con la versión nueva y
  // sin el comentario ya enviado.
  const rebased: PickingAutosaveSnapshot = {
    ...original,
    version: original.version + 1,
    savedAt: NOW,
    pendingComment: undefined,
  };

  assert.equal(savePickingAutosave(storage, rebased), true);

  assert.equal(
    loadPickingAutosave(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      version: original.version,
      now: NOW,
    }),
    null,
    'la versión anterior ya no debe ofrecerse para restaurar',
  );

  const loaded = loadPickingAutosave(storage, {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    version: original.version + 1,
    now: NOW,
  });
  assert.deepEqual(loaded?.items, original.items);
  assert.equal(loaded?.pendingComment, undefined);
});

test('clearPickingAutosave borra sólo el pedido indicado', () => {
  const storage = new MemoryStorage();
  assert.equal(savePickingAutosave(storage, snapshot()), true);
  assert.equal(savePickingAutosave(storage, snapshot({ orderId: 'pedido-2' })), true);

  assert.equal(clearPickingAutosave(storage, 'usuario-1', 'pedido-1'), true);
  assert.equal(
    loadPickingAutosave(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      version: 3,
      now: NOW,
    }),
    null,
  );
  assert.ok(
    loadPickingAutosave(storage, {
      orderId: 'pedido-2',
      userId: 'usuario-1',
      version: 3,
      now: NOW,
    }),
  );
});

test('un storage inaccesible no rompe lectura, guardado ni limpieza', () => {
  const throwingStorage: PickingAutosaveStorage = {
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

  assert.equal(savePickingAutosave(throwingStorage, snapshot()), false);
  assert.equal(
    loadPickingAutosave(throwingStorage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      version: 3,
      now: NOW,
    }),
    null,
  );
  assert.equal(clearPickingAutosave(throwingStorage, 'usuario-1', 'pedido-1'), false);
  assert.equal(savePickingAutosave(null, snapshot()), false);
  assert.equal(loadPickingAutosave(undefined, snapshot()), null);
  assert.equal(clearPickingAutosave(undefined, 'usuario-1', 'pedido-1'), false);
});
