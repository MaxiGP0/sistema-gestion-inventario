/**
 * Pruebas de la regla de totales post-picking (lib/order-totals.ts).
 * No requieren base de datos: el cálculo de importes y el mapeo de ítems
 * son funciones puras, con la misma fórmula que el alta (POST /api/orders).
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyVerifiedTotals, matchesOrderItem, resolveItemValues } from '../lib/order-totals';
import { resolveClientDiscountPercentage } from '../lib/discounts';
import { roundCurrency } from '../lib/money';

test('applyVerifiedTotals recalcula lineTotal con la cantidad verificada y el descuento del ítem', () => {
  const result = applyVerifiedTotals([
    { unitPrice: 100, verifiedQuantity: 3, itemDiscount: 10 },
    { unitPrice: 50, verifiedQuantity: 2, itemDiscount: 0 },
  ]);

  // Línea 1: 300 bruto - 30 de descuento; línea 2: 100 bruto sin descuento.
  assert.equal(result.items[0].lineTotal, 270);
  assert.equal(result.items[1].lineTotal, 100);
  assert.equal(result.subtotal, 400);
  assert.equal(result.totalDiscount, 30);
  assert.equal(result.finalTotal, 370);
});

test('los ítems sin verificar (pendientes) aportan 0 y no se facturan', () => {
  const result = applyVerifiedTotals([
    { unitPrice: 50, verifiedQuantity: 2, itemDiscount: 0 },
    { unitPrice: 80, verifiedQuantity: 0, itemDiscount: 20 }, // pendiente: nada controlado
  ]);

  assert.equal(result.items[0].lineTotal, 100);
  assert.equal(result.items[1].lineTotal, 0);
  assert.equal(result.subtotal, 100);
  assert.equal(result.totalDiscount, 0);
  assert.equal(result.finalTotal, 100);
});

test('con decimales, los importes se redondean a 2 decimales y finalTotal es la suma de líneas', () => {
  const result = applyVerifiedTotals([
    { unitPrice: 10.9, verifiedQuantity: 3, itemDiscount: 15 },
    { unitPrice: 7.77, verifiedQuantity: 4, itemDiscount: 7.5 },
  ]);

  // Línea 1: bruto 32.70, descuento 4.905 -> 4.91; línea 2: bruto 31.08, descuento 2.331 -> 2.33.
  assert.equal(result.items[0].lineTotal, 27.79);
  assert.equal(result.items[1].lineTotal, 28.75);
  assert.equal(result.subtotal, 63.78);
  assert.equal(result.totalDiscount, 7.24);
  assert.equal(result.finalTotal, 56.54);

  // Sin centavos fantasma: los totales son exactamente la suma de las líneas.
  const sumLineTotals = roundCurrency(result.items.reduce((acc, item) => acc + item.lineTotal, 0));
  assert.equal(result.finalTotal, sumLineTotals);
  assert.equal(roundCurrency(result.subtotal - result.totalDiscount), result.finalTotal);
});

test('roundCurrency redondea a 2 decimales con medio hacia arriba y tolera valores no finitos', () => {
  assert.equal(roundCurrency(1.005), 1.01);
  assert.equal(roundCurrency(4.905), 4.91);
  assert.equal(roundCurrency(2.331), 2.33);
  assert.equal(roundCurrency(32.7), 32.7);
  assert.equal(roundCurrency(-2.345), -2.35);
  assert.equal(roundCurrency(Number.NaN), 0);
  assert.equal(roundCurrency(Number.POSITIVE_INFINITY), 0);
});

test('descuento del 100% deja la línea en 0 y una lista vacía da totales en 0', () => {
  const result = applyVerifiedTotals([{ unitPrice: 25, verifiedQuantity: 4, itemDiscount: 100 }]);

  assert.equal(result.items[0].lineTotal, 0);
  assert.equal(result.subtotal, 100);
  assert.equal(result.totalDiscount, 100);
  assert.equal(result.finalTotal, 0);

  const empty = applyVerifiedTotals(
    [] as Array<{ unitPrice: number; verifiedQuantity: number; itemDiscount: number }>,
  );
  assert.deepEqual(empty, { items: [], subtotal: 0, totalDiscount: 0, finalTotal: 0 });
});

test('matchesOrderItem matchea por _id y por productId, y no matchea ítems ajenos', () => {
  const existing = {
    _id: 'a'.repeat(24),
    productId: 'b'.repeat(24),
    unitPrice: 10,
    requestedQuantity: 1,
  };

  assert.equal(matchesOrderItem(existing, { _id: existing._id }), true);
  assert.equal(matchesOrderItem(existing, { productId: existing.productId }), true);
  assert.equal(
    matchesOrderItem(existing, { _id: 'c'.repeat(24), productId: 'd'.repeat(24) }),
    false,
  );
  assert.equal(matchesOrderItem(existing, {}), false);
});

test('resolveItemValues conserva el snapshot del ítem existente y detecta faltantes', () => {
  const existing = {
    _id: 'a'.repeat(24),
    productId: 'b'.repeat(24),
    unitPrice: 12.5,
    requestedQuantity: 4,
    itemDiscount: 10,
  };

  const partial = resolveItemValues(
    existing,
    { _id: existing._id, verifiedQuantity: 2, isPending: false },
    999,
  );
  assert.equal(partial.unitPrice, 12.5); // ignora el precio de catálogo: hay snapshot del alta
  assert.equal(partial.requestedQuantity, 4);
  assert.equal(partial.itemDiscount, 10);
  assert.equal(partial.verifiedQuantity, 2);
  assert.equal(partial.isPending, false);
  assert.equal(partial.leavesPending, true); // 2 < 4

  const complete = resolveItemValues(existing, {
    _id: existing._id,
    verifiedQuantity: 4,
    isPending: false,
  });
  assert.equal(complete.leavesPending, false);

  const explicitPending = resolveItemValues(existing, {
    _id: existing._id,
    verifiedQuantity: 4,
    isPending: true,
  });
  assert.equal(explicitPending.leavesPending, true);
});

test('resolveItemValues toma precio y descuento del catálogo para ítems nuevos', () => {
  const values = resolveItemValues(
    undefined,
    { productId: 'b'.repeat(24), verifiedQuantity: 3 },
    8.25,
  );

  assert.equal(values.unitPrice, 8.25);
  // Sin cantidad pedida explícita se asume la verificada por depósito (antes quedaba en 0).
  assert.equal(values.requestedQuantity, 3);
  assert.equal(values.itemDiscount, 0);
  assert.equal(values.verifiedQuantity, 3);
  assert.equal(values.leavesPending, false);

  // La cantidad pedida que envía depósito se conserva.
  const partial = resolveItemValues(
    undefined,
    { productId: 'b'.repeat(24), requestedQuantity: 5, verifiedQuantity: 3 },
    8.25,
    10,
  );
  assert.equal(partial.requestedQuantity, 5);
  assert.equal(partial.itemDiscount, 10, 'sin descuento propio rige el del cliente');
  assert.equal(partial.leavesPending, true, '3 < 5: queda pendiente');

  // Un descuento propio del ítem pisa al del cliente.
  const custom = resolveItemValues(
    undefined,
    { productId: 'b'.repeat(24), verifiedQuantity: 2, customDiscount: 7 },
    8.25,
    10,
  );
  assert.equal(custom.itemDiscount, 7);

  const noCatalogPrice = resolveItemValues(undefined, {
    productId: 'b'.repeat(24),
    verifiedQuantity: 1,
  });
  assert.equal(noCatalogPrice.unitPrice, 0);

  const omittedQty = resolveItemValues(undefined, { productId: 'b'.repeat(24) }, 5);
  assert.equal(omittedQty.verifiedQuantity, 0);
  assert.equal(omittedQty.requestedQuantity, 0);
});

test('resolveClientDiscountPercentage prioriza la marca sobre el general y normaliza brandId poblado', () => {
  const clientConfig = {
    generalDiscount: 5,
    brandDiscounts: [
      { brandId: { _id: 'm'.repeat(24) }, discountPercentage: 12 },
      { brandId: 'n'.repeat(24), discountPercentage: 8 },
    ],
  };

  assert.equal(resolveClientDiscountPercentage(clientConfig, 'm'.repeat(24)), 12);
  assert.equal(resolveClientDiscountPercentage(clientConfig, 'n'.repeat(24)), 8);
  assert.equal(
    resolveClientDiscountPercentage(clientConfig, 'x'.repeat(24)),
    5,
    'sin marca configurada rige el general',
  );
  assert.equal(resolveClientDiscountPercentage(null, 'm'.repeat(24)), 0);
  assert.equal(
    resolveClientDiscountPercentage({ generalDiscount: '10' }, undefined),
    10,
    'normaliza strings numéricos',
  );
});

test('flujo post-picking completo: existentes + nuevo del catálogo cuadran con lo verificado', () => {
  const existingA = {
    _id: 'a'.repeat(24),
    productId: '1'.repeat(24),
    unitPrice: 100,
    requestedQuantity: 5,
    itemDiscount: 10,
  };
  const existingB = {
    _id: 'b'.repeat(24),
    productId: '2'.repeat(24),
    unitPrice: 50,
    requestedQuantity: 2,
    itemDiscount: 0,
  };
  const catalog = new Map([['3'.repeat(24), 20]]);

  const incoming = [
    { _id: existingA._id, verifiedQuantity: 3, isPending: false }, // parcial: 3 de 5
    { _id: existingB._id, verifiedQuantity: 2, isPending: false },
    { productId: '3'.repeat(24), verifiedQuantity: 4, isPending: false }, // nuevo
  ];

  const resolved = incoming.map((updatedItem) => {
    const existing = [existingA, existingB].find((item) => matchesOrderItem(item, updatedItem));
    const { leavesPending, ...itemValues } = resolveItemValues(
      existing,
      updatedItem,
      updatedItem.productId !== undefined ? catalog.get(updatedItem.productId) : undefined,
    );
    return { leavesPending, ...itemValues };
  });

  const totals = applyVerifiedTotals(resolved);

  // A: 300 bruto - 30; B: 100; nuevo: 80 (20 x 4).
  assert.deepEqual(
    totals.items.map((item) => item.lineTotal),
    [270, 100, 80],
  );
  assert.equal(totals.subtotal, 480);
  assert.equal(totals.totalDiscount, 30);
  assert.equal(totals.finalTotal, 450);

  assert.equal(resolved[0].leavesPending, true); // pedido 5, verificado 3 -> paralizado
  assert.equal(resolved[1].leavesPending, false);
  assert.equal(resolved[2].leavesPending, false);
  assert.equal(resolved[2].requestedQuantity, 4, 'el ítem nuevo conserva lo que se pidió/verificó');
});
