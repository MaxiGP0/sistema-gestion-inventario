/**
 * Pruebas de la ventana de render de bandejas largas
 * (lib/order-list-window.ts): el DOM se acota a 200 tarjetas, pero las páginas
 * cargadas se conservan para poder seguir avanzando con "Cargar más".
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getOrderRenderWindow, MAX_RENDERED_ORDERS } from '../lib/order-list-window';

function orders(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

test('con menos de 200 pedidos renderiza todo y arranca en 0', () => {
  const window = getOrderRenderWindow(orders(50));

  assert.equal(window.orders.length, 50);
  assert.equal(window.start, 0);
  assert.equal(window.loaded, 50);
  assert.equal(window.limit, MAX_RENDERED_ORDERS);
});

test('al llegar a 200 conserva la primera página completa', () => {
  const window = getOrderRenderWindow(orders(200));

  assert.equal(window.orders.length, 200);
  assert.equal(window.start, 0);
  assert.deepEqual(window.orders, orders(200));
});

test('con 500 cargados renderiza las últimas 200 y mantiene el total', () => {
  const window = getOrderRenderWindow(orders(500));

  assert.equal(window.orders.length, 200);
  assert.equal(window.start, 300);
  assert.equal(window.loaded, 500);
  assert.deepEqual(window.orders, orders(500).slice(300));
});

test('un límite personalizado también se acota y nunca es menor a 1', () => {
  assert.deepEqual(getOrderRenderWindow(orders(10), 3).orders, [8, 9, 10]);
  assert.equal(getOrderRenderWindow(orders(10), 3).start, 7);

  for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(getOrderRenderWindow(orders(10), invalid).limit, MAX_RENDERED_ORDERS);
  }
});
