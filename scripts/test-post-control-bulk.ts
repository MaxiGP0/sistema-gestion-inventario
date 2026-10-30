/**
 * Pruebas de las acciones masivas de post-control (lib/post-control-bulk.ts):
 * snapshot previo, marcado de sólo pendientes como OK y restauración para
 * "Deshacer", sin habilitar la entrega mientras queden líneas pendientes.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasUncontrolledPostItems, countUncontrolledPostItems } from '../lib/order-post-control';
import {
  buildMarkAllOkUpdates,
  buildRestorePostControlUpdates,
  snapshotPostControls,
} from '../lib/post-control-bulk';

const line = (_id: string, postControl?: string): { _id: string; postControl?: string } =>
  postControl === undefined ? { _id } : { _id, postControl };

test('snapshotPostControls normaliza los pedidos históricos a pendiente', () => {
  const snapshot = snapshotPostControls([
    line('a', 'ok'),
    line('b', 'diferencia'),
    line('c'),
    line('d', 'inventado'),
  ]);

  assert.deepEqual(snapshot, {
    a: 'ok',
    b: 'diferencia',
    c: 'pendiente',
    d: 'pendiente',
  });
});

test('buildMarkAllOkUpdates sólo marca las líneas pendientes', () => {
  const items = [line('a', 'ok'), line('b'), line('c', 'diferencia'), line('d', 'pendiente')];

  assert.deepEqual(buildMarkAllOkUpdates(items), [
    { _id: 'b', postControl: 'ok' },
    { _id: 'd', postControl: 'ok' },
  ]);
});

test('marcar todas OK no habilita la entrega si había líneas sin tocar', () => {
  const items = [line('a'), line('b', 'diferencia')];
  assert.equal(countUncontrolledPostItems(items), 1);
  assert.equal(hasUncontrolledPostItems(items), true);

  const updates = buildMarkAllOkUpdates(items);
  const updated = items.map((item) => {
    const update = updates.find((candidate) => candidate._id === item._id);
    return update ? { ...item, postControl: update.postControl } : item;
  });

  assert.equal(hasUncontrolledPostItems(updated), false);
  assert.equal(countUncontrolledPostItems(updated), 0);
  // La diferencia explícita se conserva: sólo se convierte lo pendiente.
  assert.equal(updated[1].postControl, 'diferencia');
});

test('deshacer restaura sólo las líneas que cambiaron desde el snapshot', () => {
  const snapshot = snapshotPostControls([line('a'), line('b', 'diferencia'), line('c')]);

  const current = [line('a', 'ok'), line('b', 'diferencia'), line('c', 'ok')];

  assert.deepEqual(buildRestorePostControlUpdates(current, snapshot), [
    { _id: 'a', postControl: 'pendiente' },
    { _id: 'c', postControl: 'pendiente' },
  ]);

  // Si el usuario volvió a dejar todo como estaba, no hay PATCH vacío.
  assert.deepEqual(
    buildRestorePostControlUpdates([line('a'), line('b', 'diferencia'), line('c')], snapshot),
    [],
  );
});

test('deshacer ignora líneas nuevas que no estaban en el snapshot', () => {
  const snapshot = snapshotPostControls([line('a', 'ok')]);
  const current = [line('a', 'pendiente'), line('nueva', 'pendiente')];

  assert.deepEqual(buildRestorePostControlUpdates(current, snapshot), [
    { _id: 'a', postControl: 'ok' },
  ]);
});

test('sin líneas pendientes no se genera ninguna actualización masiva', () => {
  const items = [line('a', 'ok'), line('b', 'diferencia')];

  assert.deepEqual(buildMarkAllOkUpdates(items), []);
  assert.equal(hasUncontrolledPostItems(items), false);
});
