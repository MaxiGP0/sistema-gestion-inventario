/**
 * Pruebas del estado visible de cada línea en el detalle del vendedor
 * (lib/order-line-status.ts): borrador intacto, controlado, faltante parcial y
 * sin stock, además del resumen que alimenta la alerta y los filtros.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countOrderLineShortages,
  getOrderLineStatus,
  orderLineHasShortage,
  type OrderLineStatusItem,
} from '../lib/order-line-status';

const line = (overrides: Partial<OrderLineStatusItem> = {}): OrderLineStatusItem => ({
  requestedQuantity: 10,
  verifiedQuantity: 0,
  isPending: false,
  ...overrides,
});

test('un borrador intacto se muestra neutro y no como faltante', () => {
  const item = line();

  assert.deepEqual(getOrderLineStatus(item, 'borrador'), {
    kind: 'unverified',
    tone: 'neutral',
    label: 'Sin verificar aún',
  });
  assert.equal(orderLineHasShortage(item, 'borrador'), false);
  assert.equal(countOrderLineShortages([item], 'borrador'), 0);
});

test('una línea con la cantidad completa se muestra controlada en verde', () => {
  assert.deepEqual(getOrderLineStatus(line({ verifiedQuantity: 10 }), 'facturacion'), {
    kind: 'controlled',
    tone: 'success',
    label: 'Controlado (10)',
  });

  // También cubre una verificación por encima de lo solicitado.
  assert.equal(
    getOrderLineStatus(line({ verifiedQuantity: 12 }), 'facturacion').label,
    'Controlado (12)',
  );
});

test('un faltante parcial conserva cantidad, badge ámbar y cuenta para el resumen', () => {
  const item = line({ verifiedQuantity: 6, pendingReason: 'Faltante: 6 de 10 controlados' });
  const status = getOrderLineStatus(item, 'facturacion');

  assert.deepEqual(status, {
    kind: 'partial',
    tone: 'warning',
    label: 'Faltante parcial (6 de 10)',
  });
  assert.equal(orderLineHasShortage(item, 'facturacion'), true);
  assert.equal(countOrderLineShortages([item], 'facturacion'), 1);
});

test('una línea sin stock o marcada pendiente se muestra en rojo', () => {
  const missing = line({ pendingReason: 'Sin stock en depósito' });
  assert.deepEqual(getOrderLineStatus(missing, 'paralizado'), {
    kind: 'missing',
    tone: 'danger',
    label: 'Sin stock / Pendiente',
  });
  assert.equal(orderLineHasShortage(missing, 'paralizado'), true);

  // `isPending` tiene prioridad incluso si quedó una cantidad parcial.
  const pendingWithQuantity = line({
    verifiedQuantity: 3,
    isPending: true,
    pendingReason: 'Retenido por control',
  });
  assert.equal(getOrderLineStatus(pendingWithQuantity, 'paralizado').kind, 'missing');
});

test('un motivo pendiente saca a la línea del borrador intacto', () => {
  const withReason = line({ pendingReason: 'Revisar con el cliente' });

  assert.equal(getOrderLineStatus(withReason, 'borrador').kind, 'missing');
  assert.equal(countOrderLineShortages([line(), withReason], 'borrador'), 1);
});
