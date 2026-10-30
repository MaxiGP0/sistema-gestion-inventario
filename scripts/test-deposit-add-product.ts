/**
 * Pruebas del alta rápida de productos desde depósito: descuento del cliente
 * para líneas nuevas y suma de cantidades sobre líneas existentes.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDepositAddedItem,
  depositLineTotal,
  findDepositItemByProductId,
  normalizeDepositAddQuantity,
  planDepositExistingAddition,
  type DepositCatalogProductLike,
} from '../lib/deposit-add-product';
import { applyVerifiedTotals } from '../lib/order-totals';

const brand = 'm'.repeat(24);
const otherBrand = 'n'.repeat(24);

const client = {
  generalDiscount: 5,
  brandDiscounts: [
    { brandId: brand, discountPercentage: 15 },
    { brandId: otherBrand, discountPercentage: 0 },
  ],
};

const product: DepositCatalogProductLike = {
  _id: 'p'.repeat(24),
  code: 'P-1',
  name: 'Producto de prueba',
  price: 100,
  priceWithIva: 121,
  imageUrl: '/icons/icon-192.png',
  brandId: { _id: brand, name: 'Marca de prueba' },
};

test('producto nuevo: aplica el descuento de la marca y valúa la cantidad elegida', () => {
  const item = buildDepositAddedItem(product, client, 7);

  assert.equal(item.itemDiscount, 15);
  assert.equal(item.requestedQuantity, 7);
  assert.equal(item.verifiedQuantity, 7);
  assert.equal(item.isPending, false);
  assert.equal(item.lineTotal, 595);
  assert.equal(item.productId.imageUrl, '/icons/icon-192.png');

  // Integración con los totales del pedido: 7 x 100 con 15% = 595.
  const totals = applyVerifiedTotals([item]);
  assert.equal(totals.subtotal, 700);
  assert.equal(totals.totalDiscount, 105);
  assert.equal(totals.finalTotal, 595);
});

test('producto nuevo sin descuento de marca cae al porcentaje general y redondea', () => {
  const item = buildDepositAddedItem(
    { ...product, price: 10.99, priceWithIva: 13.3, brandId: { _id: 'x', name: 'Otra' } },
    client,
    2,
  );

  assert.equal(item.itemDiscount, 5);
  assert.equal(item.lineTotal, 20.88);
  assert.equal(depositLineTotal(10.99, 0, 2), 21.98);

  // Una marca con 0% explícito pisa al general.
  const zeroDiscount = buildDepositAddedItem(
    { ...product, brandId: { _id: otherBrand, name: 'Marca sin descuento' } },
    client,
    1,
  );
  assert.equal(zeroDiscount.itemDiscount, 0);
});

test('sumar unidades a una línea agregada en depósito actualiza pedido y verificado', () => {
  const localItem = {
    productId: { _id: product._id },
    requestedQuantity: 1,
    verifiedQuantity: 1,
    unitPrice: product.price,
    itemDiscount: 15,
  };

  const plan = planDepositExistingAddition(
    localItem,
    { verifiedQty: 1, controlled: true, pendingReason: '' },
    6,
  );

  assert.equal(plan.requestedQuantity, 7);
  assert.equal(plan.verifiedQuantity, 7);
  assert.equal(plan.state.verifiedQty, 7);
  assert.equal(plan.state.controlled, true);
});

test('sumar unidades a una línea del servidor conserva lo pedido y controla lo verificado', () => {
  const serverItem = {
    _id: 'i'.repeat(24),
    productId: { _id: product._id },
    requestedQuantity: 2,
    verifiedQuantity: 0,
  };

  const plan = planDepositExistingAddition(
    serverItem,
    { verifiedQty: 0, controlled: false, pendingReason: '' },
    6,
  );

  assert.equal(plan.requestedQuantity, 2);
  assert.equal(plan.verifiedQuantity, 6);
  assert.equal(plan.state.controlled, true);
  assert.equal(plan.state.pendingReason, '');

  const partial = planDepositExistingAddition(
    { ...serverItem, requestedQuantity: 5 },
    { verifiedQty: 3, controlled: false, pendingReason: 'Faltante: 3 de 5 controlados' },
    2,
  );

  assert.equal(partial.requestedQuantity, 5);
  assert.equal(partial.verifiedQuantity, 5);
  assert.equal(partial.state.controlled, true);
  assert.equal(partial.state.pendingReason, '');
});

test('normaliza cantidades y encuentra la línea por producto', () => {
  assert.equal(normalizeDepositAddQuantity(0), 1);
  assert.equal(normalizeDepositAddQuantity(-3), 1);
  assert.equal(normalizeDepositAddQuantity(6.9), 6);

  const items = [
    { _id: 'a'.repeat(24), productId: { _id: 'x' }, requestedQuantity: 1 },
    { productId: { _id: product._id }, requestedQuantity: 3 },
  ];

  assert.equal(findDepositItemByProductId(items, product._id)?.requestedQuantity, 3);
  assert.equal(findDepositItemByProductId(items, 'inexistente'), undefined);
});
