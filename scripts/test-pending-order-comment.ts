/**
 * Pruebas del borrador local de comentarios (lib/pending-order-comment.ts):
 * persistencia por usuario/pedido, saneamiento del texto, aislamiento entre
 * pedidos y tolerancia a un storage bloqueado o datos corruptos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearPendingOrderComment,
  getPendingOrderCommentStorageKey,
  loadPendingOrderComment,
  parsePendingOrderComment,
  PENDING_ORDER_COMMENT_STORAGE_KEY,
  savePendingOrderComment,
  type PendingOrderCommentStorage,
} from '../lib/pending-order-comment';

class MemoryStorage implements PendingOrderCommentStorage {
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

test('save/load conserva el comentario del mismo usuario y pedido', () => {
  const storage = new MemoryStorage();
  const draft = {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    text: '  Falta stock del proveedor  ',
    savedAt: NOW,
  };

  assert.equal(savePendingOrderComment(storage, draft), true);
  assert.equal(PENDING_ORDER_COMMENT_STORAGE_KEY, 'sgi_pending_order_comment');
  assert.ok(storage.getItem(getPendingOrderCommentStorageKey('usuario-1', 'pedido-1')));

  assert.deepEqual(loadPendingOrderComment(storage, 'usuario-1', 'pedido-1'), {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    text: 'Falta stock del proveedor',
    savedAt: NOW,
  });
});

test('el borrador no se mezcla entre usuarios ni pedidos', () => {
  const storage = new MemoryStorage();
  assert.equal(
    savePendingOrderComment(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      text: 'Comentario privado',
      savedAt: NOW,
    }),
    true,
  );

  assert.equal(loadPendingOrderComment(storage, 'usuario-2', 'pedido-1'), null);
  assert.equal(loadPendingOrderComment(storage, 'usuario-1', 'pedido-2'), null);
});

test('el texto se recorta a 2000 caracteres y se sanea al guardar y parsear', () => {
  const storage = new MemoryStorage();
  assert.equal(
    savePendingOrderComment(storage, {
      orderId: ' pedido-1 ',
      userId: ' usuario-1 ',
      text: `  ${'x'.repeat(2500)}  `,
      savedAt: NOW,
    }),
    true,
  );

  const loaded = loadPendingOrderComment(storage, 'usuario-1', 'pedido-1');
  assert.equal(loaded?.text.length, 2000);
  assert.equal(loaded?.text, 'x'.repeat(2000));

  assert.equal(
    parsePendingOrderComment(
      JSON.stringify({
        orderId: 'pedido-1',
        userId: 'usuario-1',
        text: '   ',
        savedAt: NOW,
      }),
    ),
    null,
    'un comentario vacío no es un borrador utilizable',
  );
});

test('parsePendingOrderComment tolera JSON roto, primitivos y campos inválidos', () => {
  assert.equal(parsePendingOrderComment(null), null);
  assert.equal(parsePendingOrderComment(''), null);
  assert.equal(parsePendingOrderComment('{roto'), null);
  assert.equal(parsePendingOrderComment('[]'), null);
  assert.equal(parsePendingOrderComment('"texto"'), null);
  assert.equal(parsePendingOrderComment('{}'), null);
  assert.equal(
    parsePendingOrderComment(
      JSON.stringify({ orderId: 'p', userId: 'u', text: 'x', savedAt: 'ayer' }),
    ),
    null,
  );
  assert.equal(
    parsePendingOrderComment(JSON.stringify({ orderId: 'p', userId: '', text: 'x', savedAt: 1 })),
    null,
  );
});

test('clearPendingOrderComment borra sólo el pedido indicado', () => {
  const storage = new MemoryStorage();
  assert.equal(
    savePendingOrderComment(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      text: 'Uno',
      savedAt: NOW,
    }),
    true,
  );
  assert.equal(
    savePendingOrderComment(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-2',
      text: 'Dos',
      savedAt: NOW,
    }),
    true,
  );

  assert.equal(clearPendingOrderComment(storage, 'usuario-1', 'pedido-1'), true);
  assert.equal(loadPendingOrderComment(storage, 'usuario-1', 'pedido-1'), null);
  assert.ok(loadPendingOrderComment(storage, 'usuario-2', 'pedido-1'));
  assert.equal(clearPendingOrderComment(storage, 'usuario-1', 'pedido-1'), true);
});

test('un storage inaccesible no rompe lectura, guardado ni limpieza', () => {
  const throwingStorage: PendingOrderCommentStorage = {
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

  assert.equal(
    savePendingOrderComment(throwingStorage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      text: 'Comentario',
      savedAt: NOW,
    }),
    false,
  );
  assert.equal(loadPendingOrderComment(throwingStorage, 'usuario-1', 'pedido-1'), null);
  assert.equal(clearPendingOrderComment(throwingStorage, 'usuario-1', 'pedido-1'), false);

  assert.equal(
    savePendingOrderComment(null, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      text: 'Comentario',
      savedAt: NOW,
    }),
    false,
  );
  assert.equal(loadPendingOrderComment(undefined, 'usuario-1', 'pedido-1'), null);
  assert.equal(clearPendingOrderComment(undefined, 'usuario-1', 'pedido-1'), false);
});
