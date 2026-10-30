/**
 * Pruebas del control rápido de picking (lib/picking-control.ts):
 * derivación del estado, contador de pendientes, marcado masivo con la
 * cantidad pedida y restauración del snapshot para "Deshacer".
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPickingQuantityDelta,
  buildPickingState,
  countPendingPickingLines,
  countQuickControlCandidates,
  markPickingLineOutOfStock,
  markPickingLineRequested,
  markRemainingLinesRequested,
  PENDING_REASON_OUT_OF_STOCK,
  pickingItemKey,
  restorePickingSnapshot,
  setPickingLineQuantity,
  shouldShowPickingShortcuts,
} from '../lib/picking-control';
import { PENDING_REASON_REMOVED } from '../lib/order-totals';

const item = (overrides: Record<string, unknown> = {}) => ({
  _id: 'linea-1',
  requestedQuantity: 5,
  verifiedQuantity: 3,
  isPending: false,
  ...overrides,
});

test('pickingItemKey usa _id, producto, nombre o código como respaldo', () => {
  assert.equal(pickingItemKey({ _id: 'a', requestedQuantity: 1 }), 'a');
  assert.equal(
    pickingItemKey({ productId: { _id: 'producto' }, requestedQuantity: 1 }),
    'producto',
  );
  assert.equal(pickingItemKey({ productName: 'Producto X', requestedQuantity: 1 }), 'Producto X');
  assert.equal(pickingItemKey({ productCode: 'COD-1', requestedQuantity: 1 }), 'COD-1');
  assert.equal(pickingItemKey({ requestedQuantity: 1 }), '');
});

test('buildPickingState deriva control, cantidad y motivo desde el pedido', () => {
  const state = buildPickingState([
    item({ _id: 'controlada' }),
    item({ _id: 'sin-verificar', verifiedQuantity: 0 }),
    item({
      _id: 'pendiente-guardada',
      verifiedQuantity: 5,
      isPending: true,
      pendingReason: 'Sin stock',
    }),
  ]);

  assert.deepEqual(state.controlada, {
    verifiedQty: 3,
    controlled: true,
    pendingReason: '',
  });
  assert.deepEqual(state['sin-verificar'], {
    verifiedQty: 5,
    controlled: false,
    pendingReason: '',
  });
  // Aunque conserve cantidad verificada, una línea marcada pendiente no está
  // controlada: es la regla que evita facturar un faltante.
  assert.deepEqual(state['pendiente-guardada'], {
    verifiedQty: 5,
    controlled: false,
    pendingReason: 'Sin stock',
  });
});

test('el contador de pendientes sólo cuenta líneas no controladas', () => {
  const items = [
    item({ _id: 'a', verifiedQuantity: 5 }),
    item({ _id: 'b', verifiedQuantity: 0 }),
    item({ _id: 'c', verifiedQuantity: 0 }),
  ];
  const state = buildPickingState(items);

  assert.equal(countPendingPickingLines(items, state), 2);
});

test('la acción masiva controla pendientes con la cantidad pedida', () => {
  const items = [
    item({ _id: 'ya-controlada', requestedQuantity: 5, verifiedQuantity: 2 }),
    item({ _id: 'pendiente-1', requestedQuantity: 4, verifiedQuantity: 0 }),
    item({ _id: 'pendiente-2', requestedQuantity: 7, verifiedQuantity: 3, isPending: true }),
  ];
  const state = buildPickingState(items);

  const result = markRemainingLinesRequested(items, state);

  assert.equal(result.changed, 2);
  // La línea ya controlada conserva su cantidad parcial (faltante deliberado).
  assert.deepEqual(result.state['ya-controlada'], {
    verifiedQty: 2,
    controlled: true,
    pendingReason: '',
  });
  assert.deepEqual(result.state['pendiente-1'], {
    verifiedQty: 4,
    controlled: true,
    pendingReason: '',
  });
  assert.deepEqual(result.state['pendiente-2'], {
    verifiedQty: 7,
    controlled: true,
    pendingReason: '',
  });
  assert.equal(countPendingPickingLines(items, result.state), 0);
});

test('la acción masiva no resucita líneas eliminadas en depósito', () => {
  const items = [
    item({ _id: 'eliminada', requestedQuantity: 3, verifiedQuantity: 0 }),
    item({ _id: 'pendiente', requestedQuantity: 2, verifiedQuantity: 0 }),
  ];
  const state = buildPickingState(items);
  state.eliminada = { verifiedQty: 0, controlled: false, pendingReason: PENDING_REASON_REMOVED };

  assert.equal(countQuickControlCandidates(items, state), 1);

  const result = markRemainingLinesRequested(items, state);
  assert.equal(result.changed, 1);
  assert.equal(result.state.eliminada.controlled, false);
  assert.equal(result.state.eliminada.pendingReason, PENDING_REASON_REMOVED);
  assert.equal(result.state.pendiente.controlled, true);
});

test('deshacer restaura exactamente el estado anterior y el contador', () => {
  const items = [
    item({ _id: 'a', requestedQuantity: 5, verifiedQuantity: 1 }),
    item({ _id: 'b', requestedQuantity: 2, verifiedQuantity: 0 }),
  ];
  const before = buildPickingState(items);
  const beforeCopy = structuredClone(before);

  const result = markRemainingLinesRequested(items, before);
  assert.equal(result.changed, 1);
  assert.equal(countPendingPickingLines(items, result.state), 0);

  const restored = restorePickingSnapshot(result.snapshot);
  assert.deepEqual(restored, beforeCopy);
  assert.equal(countPendingPickingLines(items, restored), 1);

  // Restaurar devuelve una copia: mutar el resultado no altera el snapshot.
  restored.a.verifiedQty = 99;
  assert.equal(result.snapshot.a.verifiedQty, 1);
});

test('sin líneas pendientes la acción masiva no cambia nada', () => {
  const items = [item({ _id: 'a', requestedQuantity: 5, verifiedQuantity: 5 })];
  const state = buildPickingState(items);

  assert.equal(countQuickControlCandidates(items, state), 0);

  const result = markRemainingLinesRequested(items, state);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.state, state);
  assert.deepEqual(result.snapshot, state);
});

test('ajustar la cantidad con los steppers controla la línea sin otro toque', () => {
  const items = [item({ _id: 'linea-1', requestedQuantity: 5, verifiedQuantity: 0 })];
  const uncontrolled = { verifiedQty: 0, controlled: false, pendingReason: '' };

  assert.equal(countPendingPickingLines(items, { 'linea-1': uncontrolled }), 1);

  const afterPlus = applyPickingQuantityDelta(uncontrolled, 1, 5);
  assert.deepEqual(afterPlus, { verifiedQty: 1, controlled: true, pendingReason: '' });
  assert.equal(countPendingPickingLines(items, { 'linea-1': afterPlus }), 0);

  const afterMinus = applyPickingQuantityDelta(afterPlus, -1, 5);
  assert.deepEqual(afterMinus, {
    verifiedQty: 0,
    controlled: false,
    pendingReason: PENDING_REASON_OUT_OF_STOCK,
  });
  assert.equal(countPendingPickingLines(items, { 'linea-1': afterMinus }), 1);

  // Al llegar a la cantidad pedida el motivo de faltante deja de aplicar.
  const partial = {
    verifiedQty: 4,
    controlled: true,
    pendingReason: 'Faltante: 4 de 5 controlados',
  };
  assert.deepEqual(applyPickingQuantityDelta(partial, 1, 5), {
    verifiedQty: 5,
    controlled: true,
    pendingReason: '',
  });

  // No se puede bajar de 0 con el stepper.
  assert.equal(
    applyPickingQuantityDelta({ ...uncontrolled, verifiedQty: 0 }, -1, 5).verifiedQty,
    0,
  );
});

test('escribir la cantidad controla la línea y permite dejarla pendiente en 0', () => {
  const partial = setPickingLineQuantity(
    { verifiedQty: 0, controlled: false, pendingReason: PENDING_REASON_OUT_OF_STOCK },
    3,
    5,
  );
  assert.deepEqual(partial, { verifiedQty: 3, controlled: true, pendingReason: '' });

  const withReason = setPickingLineQuantity(
    { verifiedQty: 3, controlled: true, pendingReason: 'Faltante: 3 de 5 controlados' },
    4,
    5,
  );
  assert.deepEqual(withReason, {
    verifiedQty: 4,
    controlled: true,
    pendingReason: 'Faltante: 3 de 5 controlados',
  });

  assert.deepEqual(setPickingLineQuantity(withReason, 5, 5), {
    verifiedQty: 5,
    controlled: true,
    pendingReason: '',
  });

  // Al bajar a 0 se conserva el motivo escrito; si no había, se sugiere uno.
  assert.deepEqual(setPickingLineQuantity(withReason, 0, 5), {
    verifiedQty: 0,
    controlled: false,
    pendingReason: 'Faltante: 3 de 5 controlados',
  });

  assert.deepEqual(setPickingLineQuantity(withReason, -2, 5), {
    verifiedQty: 0,
    controlled: false,
    pendingReason: 'Faltante: 3 de 5 controlados',
  });

  assert.deepEqual(
    setPickingLineQuantity({ verifiedQty: 5, controlled: true, pendingReason: '' }, 0, 5),
    {
      verifiedQty: 0,
      controlled: false,
      pendingReason: PENDING_REASON_OUT_OF_STOCK,
    },
  );
});

test('los atajos "= Solicitado" y "Sin stock" resuelven la línea en un toque', () => {
  const items = [item({ _id: 'linea-1', requestedQuantity: 7 })];
  const requested = markPickingLineRequested(7);

  assert.deepEqual(requested, {
    verifiedQty: 7,
    controlled: true,
    pendingReason: '',
  });
  assert.equal(countPendingPickingLines(items, { 'linea-1': requested }), 0);

  const outOfStock = markPickingLineOutOfStock();
  assert.deepEqual(outOfStock, {
    verifiedQty: 0,
    controlled: false,
    pendingReason: PENDING_REASON_OUT_OF_STOCK,
  });
  assert.equal(countPendingPickingLines(items, { 'linea-1': outOfStock }), 1);
});

test('los atajos sólo se muestran si la línea no está controlada o difiere de lo pedido', () => {
  assert.equal(shouldShowPickingShortcuts(undefined, 5), true);
  assert.equal(
    shouldShowPickingShortcuts({ verifiedQty: 5, controlled: false, pendingReason: '' }, 5),
    true,
  );
  assert.equal(
    shouldShowPickingShortcuts({ verifiedQty: 3, controlled: true, pendingReason: '' }, 5),
    true,
  );
  assert.equal(
    shouldShowPickingShortcuts({ verifiedQty: 5, controlled: true, pendingReason: '' }, 5),
    false,
  );
});
