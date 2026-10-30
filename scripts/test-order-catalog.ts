/**
 * Pruebas de la lógica pura del alta de pedidos (lib/order-catalog.ts):
 * normalización de descuentos, agrupación del catálogo, totales con precedencia
 * producto > marca > general y armado de ítems para POST /api/orders.
 *
 * No requieren base de datos, navegador ni React.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyQuantityDelta,
  buildOrderItems,
  calculateLineSubtotal,
  calculateOrderTotals,
  clampDiscount,
  collectMissingProductIds,
  countSelectedItems,
  formatGeneralDiscountInput,
  getBrandId,
  getClientDiscounts,
  getSelectedCatalogProducts,
  getSelectedOrderLines,
  groupProductsByBrand,
  parseDiscountInput,
  parseGeneralDiscount,
  parseQuantityInput,
  resolveCardDiscount,
  resolveItemDiscount,
  SELECTED_PRODUCTS_FILTER,
  type OrderCatalogProduct,
} from '../lib/order-catalog';

const product = (
  id: string,
  brandId: string | { _id: string; name?: string },
  price: number,
): OrderCatalogProduct => ({
  _id: id,
  brandId,
  code: `C-${id}`,
  name: `Producto ${id}`,
  price,
});

test('getBrandId normaliza brandId poblado, plano y ausente', () => {
  assert.equal(getBrandId('marca-1'), 'marca-1');
  assert.equal(getBrandId({ _id: 'marca-2', name: 'Marca 2' }), 'marca-2');
  assert.equal(getBrandId(null), '');
  assert.equal(getBrandId(undefined), '');
});

test('parseDiscountInput distingue campo vacío, texto inválido y rango', () => {
  assert.equal(parseDiscountInput(''), undefined, 'vacío = heredar');
  assert.equal(parseDiscountInput('   '), undefined);
  assert.equal(parseDiscountInput('abc'), 0, 'inválido no debe romper el cálculo');
  assert.equal(parseDiscountInput('-5'), 0);
  assert.equal(parseDiscountInput('150'), 100);
  assert.equal(parseDiscountInput('12.5'), 12.5);
  assert.equal(parseGeneralDiscount(''), 0);
  assert.equal(
    parseGeneralDiscount(' 7,5 '),
    7,
    'parseFloat corta en la coma como el input original',
  );
  assert.equal(clampDiscount(Number.NaN), 0);
  assert.equal(clampDiscount(Number.POSITIVE_INFINITY), 0);
});

test('formatGeneralDiscountInput usa el placeholder para 0 y conserva decimales', () => {
  assert.equal(formatGeneralDiscountInput(0), '');
  assert.equal(formatGeneralDiscountInput(5), '5');
  assert.equal(formatGeneralDiscountInput(7.5), '7.5');
  assert.equal(formatGeneralDiscountInput(Number.NaN), '');
  assert.equal(parseGeneralDiscount(formatGeneralDiscountInput(0)), 0);
  assert.equal(parseGeneralDiscount(formatGeneralDiscountInput(7.5)), 7.5);
});

test('parseQuantityInput y applyQuantityDelta nunca dejan cantidades negativas', () => {
  assert.equal(parseQuantityInput('3'), 3);
  assert.equal(parseQuantityInput('3.9'), 3);
  assert.equal(parseQuantityInput('-2'), 0);
  assert.equal(parseQuantityInput(''), 0);
  assert.equal(parseQuantityInput('abc'), 0);

  assert.equal(applyQuantityDelta(undefined, 1), 1);
  assert.equal(applyQuantityDelta(2, -1), 1);
  assert.equal(applyQuantityDelta(0, -1), 0);
  assert.equal(applyQuantityDelta(Number.NaN, 2), 2);
});

test('getClientDiscounts normaliza brandId poblado y limita porcentajes', () => {
  const discounts = getClientDiscounts({
    _id: 'cliente-1',
    code: 'CLI-1',
    name: 'Cliente Uno',
    generalDiscount: 7.5,
    brandDiscounts: [
      { brandId: { _id: 'marca-1' }, discountPercentage: 12.5 },
      { brandId: 'marca-2', discountPercentage: 150 },
      { brandId: '', discountPercentage: 5 },
    ],
  });

  assert.deepEqual(discounts, {
    general: 7.5,
    brandDiscounts: { 'marca-1': 12.5, 'marca-2': 100 },
  });
  assert.deepEqual(getClientDiscounts(null), { general: 0, brandDiscounts: {} });
});

test('groupProductsByBrand agrupa conservando el orden y resuelve nombres', () => {
  const brandNames = new Map([['marca-2', 'Marca Dos']]);
  const groups = groupProductsByBrand(
    [
      product('a', { _id: 'marca-1', name: 'Marca Uno' }, 10),
      product('b', 'marca-2', 20),
      product('c', { _id: 'marca-1', name: 'Marca Uno' }, 30),
      product('d', '', 40),
    ],
    brandNames,
  );

  assert.deepEqual(
    groups.map((group) => ({
      brandId: group.brandId,
      brandName: group.brandName,
      ids: group.products.map((item) => item._id),
    })),
    [
      { brandId: 'marca-1', brandName: 'Marca Uno', ids: ['a', 'c'] },
      { brandId: 'marca-2', brandName: 'Marca Dos', ids: ['b'] },
      { brandId: '', brandName: 'General', ids: ['d'] },
    ],
  );
});

test('countSelectedItems cuenta unidades e ítems distintos ignorando cantidades no positivas', () => {
  assert.deepEqual(countSelectedItems({ a: 2, b: 1, c: 0, d: -3 }), {
    units: 3,
    distinct: 2,
  });
  assert.deepEqual(countSelectedItems({}), { units: 0, distinct: 0 });
});

test('getSelectedCatalogProducts sólo devuelve productos cacheados con cantidad > 0', () => {
  const products = {
    a: product('a', 'm1', 100),
    b: product('b', 'm2', 50),
    c: product('c', 'm1', 999),
  };

  assert.deepEqual(
    getSelectedCatalogProducts({ a: 2, b: 0, c: 1, missing: 4 }, products).map((item) => item._id),
    ['a', 'c'],
  );
  assert.deepEqual(getSelectedCatalogProducts({}, products), []);
  assert.deepEqual(getSelectedCatalogProducts({ missing: 2 }, products), []);
  assert.equal(SELECTED_PRODUCTS_FILTER, 'SELECTED');
});

test('getSelectedOrderLines conserva los faltantes para mostrar su carga y respeta el orden', () => {
  const products = {
    b: product('b', 'm2', 50),
  };

  const lines = getSelectedOrderLines({ a: 2, b: 1, c: 0, missing: 3 }, products);

  assert.deepEqual(
    lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      productIdInCache: line.product?._id ?? null,
    })),
    [
      { productId: 'a', quantity: 2, productIdInCache: null },
      { productId: 'b', quantity: 1, productIdInCache: 'b' },
      { productId: 'missing', quantity: 3, productIdInCache: null },
    ],
  );

  const groups = groupProductsByBrand(
    getSelectedCatalogProducts(
      { a: 2, b: 1 },
      { a: product('a', 'm1', 10), b: product('b', 'm2', 20) },
    ),
    new Map([
      ['m1', 'Marca 1'],
      ['m2', 'Marca 2'],
    ]),
  );

  assert.deepEqual(
    groups.map((group) => ({
      brandId: group.brandId,
      ids: group.products.map((item) => item._id),
    })),
    [
      { brandId: 'm1', ids: ['a'] },
      { brandId: 'm2', ids: ['b'] },
    ],
  );
});

test('resolveItemDiscount aplica la precedencia producto > marca > general', () => {
  assert.equal(resolveItemDiscount('p1', 'm1', { p1: 5 }, { m1: 20 }, 10), 5);
  assert.equal(resolveItemDiscount('p1', 'm1', {}, { m1: 20 }, 10), 20);
  assert.equal(resolveItemDiscount('p1', 'm1', {}, {}, 10), 10);
  assert.equal(resolveItemDiscount('p1', 'm1', {}, {}, 0), 0);
  assert.equal(resolveItemDiscount('p1', 'm1', { p1: Number.NaN }, { m1: 20 }, 10), 20);
});

test('resolveCardDiscount respeta el override manual (incluido 0%) y cae al descuento de la marca', () => {
  assert.equal(resolveCardDiscount('', 10), 10);
  assert.equal(resolveCardDiscount(0, 10), 0, 'un 0% manual no debe heredar la marca');
  assert.equal(resolveCardDiscount('12.5', 10), 12.5);
  assert.equal(
    resolveCardDiscount('abc', 10),
    10,
    'texto inválido vuelve al descuento por defecto',
  );
  assert.equal(resolveCardDiscount(150, 10), 100);
  assert.equal(resolveCardDiscount(Number.NaN, 10), 10);
});

test('calculateLineSubtotal muestra el subtotal de la tarjeta con el descuento efectivo', () => {
  assert.equal(calculateLineSubtotal(1000, 2, 5), 1900);
  assert.equal(calculateLineSubtotal(1000, 2, 0), 2000);
  assert.equal(calculateLineSubtotal(1000, 2, 100), 0);
  assert.equal(calculateLineSubtotal(750, 0, 10), 0, 'sin unidades no suma al carrito');
  assert.equal(calculateLineSubtotal(750, -2, 10), 0);
  assert.equal(calculateLineSubtotal(Number.NaN, 3, 10), 0);
  assert.equal(calculateLineSubtotal(1000, 3, 150), 0, 'el descuento se limita a 100%');
});

test('calculateOrderTotals separa descuentos por origen y respeta la precedencia', () => {
  const products = {
    a: product('a', 'm1', 100),
    b: product('b', 'm2', 50),
    c: product('c', 'm1', 999),
  };

  const totals = calculateOrderTotals({
    quantities: { a: 3, b: 2, c: 0 },
    productCache: products,
    itemDiscounts: { a: 5 },
    brandDiscounts: { m1: 20 },
    generalDiscount: 10,
  });

  // A: 300 con 5% manual = 15. B: 100 con 10% general = 10. C: cantidad 0.
  assert.equal(totals.subtotal, 400);
  assert.equal(totals.totalDiscount, 25);
  assert.equal(totals.finalTotal, 375);
  assert.deepEqual(totals.discountBySource, { general: 10, brand: 0, item: 15 });
});

test('calculateOrderTotals usa la marca cuando no hay ajuste manual y omite productos sin caché', () => {
  const totals = calculateOrderTotals({
    quantities: { a: 3, b: 2, missing: 10 },
    productCache: {
      a: product('a', 'm1', 100),
      b: product('b', 'm2', 50),
    },
    itemDiscounts: {},
    brandDiscounts: { m1: 20 },
    generalDiscount: 10,
  });

  // A: 300 con 20% de marca = 60. B: 100 con 10% general = 10.
  assert.equal(totals.subtotal, 400);
  assert.equal(totals.totalDiscount, 70);
  assert.equal(totals.finalTotal, 330);
  assert.deepEqual(totals.discountBySource, { general: 10, brand: 60, item: 0 });
});

test('un descuento manual de 0% pisa a la marca y queda registrado como origen producto', () => {
  const totals = calculateOrderTotals({
    quantities: { a: 1 },
    productCache: { a: product('a', 'm1', 200) },
    itemDiscounts: { a: 0 },
    brandDiscounts: { m1: 20 },
    generalDiscount: 10,
  });

  assert.equal(totals.subtotal, 200);
  assert.equal(totals.totalDiscount, 0);
  assert.equal(totals.finalTotal, 200);
  assert.deepEqual(totals.discountBySource, { general: 0, brand: 0, item: 0 });
});

test('buildOrderItems arma el POST con el descuento efectivo y detecta productos sin caché', () => {
  const result = buildOrderItems({
    quantities: { a: 2, b: 1, c: 0, missing: 4 },
    productCache: {
      a: product('a', { _id: 'm1', name: 'Marca 1' }, 100),
      b: product('b', 'm2', 50),
    },
    itemDiscounts: { a: 5 },
    brandDiscounts: { m2: 15 },
    generalDiscount: 10,
  });

  assert.deepEqual(result.items, [
    { productId: 'a', requestedQuantity: 2, customDiscount: 5 },
    { productId: 'b', requestedQuantity: 1, customDiscount: 15 },
  ]);
  assert.deepEqual(result.missingProductIds, ['missing']);

  const empty = buildOrderItems({
    quantities: { a: 0 },
    productCache: { a: product('a', 'm1', 100) },
    itemDiscounts: {},
    brandDiscounts: {},
    generalDiscount: 10,
  });
  assert.deepEqual(empty, { items: [], missingProductIds: [] });
});

test('collectMissingProductIds ignora cacheados, cantidades 0 y ya solicitados, y limita el lote', () => {
  assert.deepEqual(
    collectMissingProductIds(
      { a: 2, b: 1, c: 0, d: 3 },
      { a: product('a', 'm1', 10) },
      new Set(['b']),
    ),
    ['d'],
  );

  assert.deepEqual(collectMissingProductIds({ a: 1, b: 1, c: 1 }, {}, new Set(), 2), ['a', 'b']);
});
