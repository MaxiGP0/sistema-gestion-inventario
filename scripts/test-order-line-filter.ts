/**
 * Pruebas de los filtros rápidos de líneas (lib/order-line-filter.ts):
 * conteos de los chips, filtrado por pendiente/diferencia y búsqueda liviana
 * por código o nombre sin distinguir acentos ni mayúsculas.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countOrderLineFilters,
  filterOrderLines,
  matchesOrderLineSearch,
  normalizeOrderLineSearch,
  orderLineSearchText,
  type OrderLineFilterItemLike,
} from '../lib/order-line-filter';

interface TestLine extends OrderLineFilterItemLike {
  id: string;
  pending: boolean;
  difference: boolean;
}

const line = (overrides: Partial<TestLine> = {}): TestLine => ({
  id: 'linea',
  productCode: 'COD-1',
  productName: 'Producto',
  pending: false,
  difference: false,
  ...overrides,
});

const predicates = {
  isPending: (item: TestLine) => item.pending,
  hasDifference: (item: TestLine) => item.difference,
};

const lines = [
  line({ id: 'a', productCode: 'AMX-500', productName: 'Amoxicilina 500', pending: true }),
  line({
    id: 'b',
    productCode: 'IBU-400',
    productName: 'Ibuprofeno 400',
    difference: true,
  }),
  line({
    id: 'c',
    productCode: 'PAR-100',
    productName: 'Paracetamol 100',
    pending: true,
    difference: true,
  }),
];

test('los conteos de los chips se calculan sobre todas las líneas', () => {
  assert.deepEqual(countOrderLineFilters(lines, predicates), {
    all: 3,
    pending: 2,
    difference: 2,
  });

  assert.deepEqual(countOrderLineFilters([], predicates), {
    all: 0,
    pending: 0,
    difference: 0,
  });
});

test('los filtros pendiente y diferencia conservan el orden original', () => {
  assert.deepEqual(
    filterOrderLines(lines, { filter: 'pending' }, predicates).map((item) => item.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    filterOrderLines(lines, { filter: 'difference' }, predicates).map((item) => item.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    filterOrderLines(lines, { filter: 'all' }, predicates).map((item) => item.id),
    ['a', 'b', 'c'],
  );
});

test('la búsqueda encuentra por código, nombre y tokens sin acentos', () => {
  assert.equal(matchesOrderLineSearch(lines[0], 'AMX-500'), true);
  assert.equal(matchesOrderLineSearch(lines[0], 'amoxi'), true);
  assert.equal(matchesOrderLineSearch(lines[0], 'AMÓXICILINA 500'), true);
  assert.equal(matchesOrderLineSearch(lines[0], '500 amx'), true);
  assert.equal(matchesOrderLineSearch(lines[0], 'ibuprofeno'), false);
  assert.equal(matchesOrderLineSearch(lines[0], '   '), true);
});

test('el respaldo en productId permite buscar pedidos con snapshots incompletos', () => {
  const populated = line({
    productCode: undefined,
    productName: undefined,
    productId: { code: 'POB-77', name: 'Producto Poblado' },
  });

  assert.equal(orderLineSearchText(populated), 'pob-77 producto poblado');
  assert.equal(matchesOrderLineSearch(populated, 'poblado'), true);
  assert.equal(normalizeOrderLineSearch('  Añil  '), 'anil');
});

test('chip + búsqueda se combinan y devuelven vacío cuando no hay coincidencias', () => {
  assert.deepEqual(
    filterOrderLines(lines, { filter: 'pending', query: 'paracetamol' }, predicates).map(
      (item) => item.id,
    ),
    ['c'],
  );

  assert.deepEqual(
    filterOrderLines(lines, { filter: 'difference', query: 'ibuprofeno' }, predicates).map(
      (item) => item.id,
    ),
    ['b'],
  );

  assert.deepEqual(
    filterOrderLines(lines, { filter: 'all', query: 'inexistente' }, predicates),
    [],
  );
});

test('una línea fijada se conserva visible aunque el chip o la búsqueda ya no la incluyan', () => {
  const dynamic = [
    line({ id: 'a', productCode: 'AMX-500', productName: 'Amoxicilina 500', pending: false }),
    line({ id: 'b', productCode: 'IBU-400', productName: 'Ibuprofeno 400', pending: true }),
    line({ id: 'c', productCode: 'PAR-100', productName: 'Paracetamol 100', pending: true }),
  ];
  const keyOf = (item: TestLine) => item.id;

  assert.deepEqual(
    filterOrderLines(dynamic, { filter: 'pending' }, predicates, keyOf).map((item) => item.id),
    ['b', 'c'],
    'sin pin la línea controlada sale del filtro',
  );

  assert.deepEqual(
    filterOrderLines(
      dynamic,
      { filter: 'pending', pinnedKeys: new Set(['a']) },
      predicates,
      keyOf,
    ).map((item) => item.id),
    ['a', 'b', 'c'],
    'el pin conserva la línea activa en su posición original',
  );

  assert.deepEqual(
    filterOrderLines(
      dynamic,
      { filter: 'pending', query: 'ibuprofeno', pinnedKeys: new Set(['a']) },
      predicates,
      keyOf,
    ).map((item) => item.id),
    ['a', 'b'],
    'la búsqueda tampoco hace desaparecer la línea activa',
  );

  assert.deepEqual(
    filterOrderLines(
      dynamic,
      { filter: 'pending', pinnedKeys: new Set(['inexistente']) },
      predicates,
      keyOf,
    ).map((item) => item.id),
    ['b', 'c'],
    'un pin que no pertenece al pedido no altera el filtro',
  );

  assert.deepEqual(
    filterOrderLines(dynamic, { filter: 'pending', pinnedKeys: new Set(['a']) }, predicates).map(
      (item) => item.id,
    ),
    ['a', 'b', 'c'],
    'sin extractor explícito usa el id de la línea',
  );
});
