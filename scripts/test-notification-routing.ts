/**
 * Pruebas de lib/notification-routing.ts, el destino que resuelve
 * NotificationsBell al hacer clic en una notificación con pedido:
 * - En el dashboard (currentRole 'all') el destino se infiere por targetRole
 *   para que el clic navegue al pedido.
 * - En una bandeja concreta manda el rol actual: las notificaciones globales
 *   se abren en la bandeja en la que está el usuario.
 * - Sin orderId no hay navegación; con destino ambiguo (targetRole 'all' o
 *   desconocido) devuelve null para que la UI ofrezca elegir la bandeja.
 *
 * No requiere DOM ni base de datos. Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveOrderHref } from '../lib/notification-routing';

const ORDER_ID = '64b7f1c2e4b0a1d2f3a4b5c6';

test('el dashboard infiere depósito por targetRole', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'all', targetRole: 'deposit', orderId: ORDER_ID }),
    `/deposit/orders/${ORDER_ID}`,
  );
});

test('el dashboard infiere facturación por targetRole', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'all', targetRole: 'billing', orderId: ORDER_ID }),
    `/billing/orders/${ORDER_ID}`,
  );
});

test('en la bandeja de depósito manda el rol actual aunque la notificación sea global', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'deposit', targetRole: 'all', orderId: ORDER_ID }),
    `/deposit/orders/${ORDER_ID}`,
  );
});

test('controlador usa la bandeja histórica deposit', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'controlador', targetRole: 'all', orderId: ORDER_ID }),
    `/deposit/orders/${ORDER_ID}`,
  );
});

test('en facturación manda el rol actual aunque la notificación sea global', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'billing', targetRole: 'all', orderId: ORDER_ID }),
    `/billing/orders/${ORDER_ID}`,
  );
});

test('el dashboard infiere la bandeja privada del vendedor por targetRole', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'all', targetRole: 'vendor', orderId: ORDER_ID }),
    `/orders/${ORDER_ID}`,
  );
});

test('en la bandeja del vendedor manda el rol actual aunque la notificación sea global', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'vendor', targetRole: 'all', orderId: ORDER_ID }),
    `/orders/${ORDER_ID}`,
  );
  assert.equal(
    resolveOrderHref({ currentRole: 'vendedor', targetRole: 'all', orderId: ORDER_ID }),
    `/orders/${ORDER_ID}`,
  );
});

test('sin orderId no hay navegación', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'all', targetRole: 'deposit', orderId: undefined }),
    null,
  );
  assert.equal(resolveOrderHref({ currentRole: 'all', targetRole: 'deposit', orderId: '' }), null);
});

test('destino ambiguo en el dashboard: targetRole all devuelve null (la UI deja elegir)', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'all', targetRole: 'all', orderId: ORDER_ID }),
    null,
  );
});

test('targetRole desconocido en el dashboard no inventa bandeja', () => {
  assert.equal(
    resolveOrderHref({ currentRole: 'all', targetRole: 'otro', orderId: ORDER_ID }),
    null,
  );
});
