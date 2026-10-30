/**
 * Prueba compartida de la resolución de descuentos (`lib/discounts.ts`), que
 * usan el alta de pedidos (UI y `createOrderDraft`) y el picking.
 *
 * Ante marcas repetidas en la ficha del cliente gana la primera coincidencia,
 * y el descuento manual de un producto (map por producto) sigue pisando al de
 * la marca y al general.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildClientDiscountResolver, resolveClientDiscountPercentage } from '../lib/discounts';
import {
  getClientDiscounts,
  resolveItemDiscount,
  type OrderCatalogClient,
} from '../lib/order-catalog';
import { createOrderDraft } from '../lib/services/orders';

const brandA = 'm'.repeat(24);
const brandB = 'n'.repeat(24);

const client: OrderCatalogClient = {
  _id: 'c'.repeat(24),
  code: 'CLI-1',
  name: 'Cliente Demo',
  generalDiscount: 5,
  brandDiscounts: [
    { brandId: { _id: brandA }, discountPercentage: 15 }, // brandId poblado
    { brandId: brandA, discountPercentage: 40 }, // repetida: debe ganar el 15
    { brandId: brandB, discountPercentage: 0 }, // 0% de marca pisa al general
  ],
};

test('marcas repetidas: gana la primera y el map por producto mantiene la precedencia', () => {
  // Resolver compartido: alta del servidor y picking.
  const resolver = buildClientDiscountResolver(client);
  assert.equal(resolver.brandPercentage(brandA), 15);
  assert.equal(resolver.resolveForBrand(brandA), 15);
  assert.equal(resolver.resolveForBrand(brandB), 0);
  assert.equal(resolver.resolveForBrand('otra-marca'), 5);
  assert.equal(resolveClientDiscountPercentage(client, brandA), 15);

  // Alta en la UI: el formulario recibe el mismo map, sin que el duplicado pise al primero.
  const ui = getClientDiscounts(client);
  assert.deepEqual(ui, {
    general: 5,
    brandDiscounts: { [brandA]: 15, [brandB]: 0 },
  });

  // Map manual por producto: pisa a marca/general, incluso con 0%.
  assert.equal(resolveItemDiscount('p1', brandA, { p1: 7 }, ui.brandDiscounts, ui.general), 7);
  assert.equal(resolveItemDiscount('p1', brandA, { p1: 0 }, ui.brandDiscounts, ui.general), 0);
  assert.equal(resolveItemDiscount('p2', brandA, {}, ui.brandDiscounts, ui.general), 15);
  assert.equal(resolveItemDiscount('p3', brandB, {}, ui.brandDiscounts, ui.general), 0);

  // Alta del servidor: usa el mismo resolver y respeta el customDiscount de cada producto.
  const draft = createOrderDraft({
    clientId: client._id,
    client,
    products: [
      { _id: 'p1', code: 'P-1', name: 'Producto 1', price: 100, brandId: brandA },
      { _id: 'p2', code: 'P-2', name: 'Producto 2', price: 100, brandId: brandB },
      { _id: 'p3', code: 'P-3', name: 'Producto 3', price: 100, brandId: brandA },
    ],
    items: [
      { productId: 'p1', requestedQuantity: 1 },
      { productId: 'p2', requestedQuantity: 1 },
      { productId: 'p3', requestedQuantity: 1, customDiscount: 7 },
    ],
    createdBy: 'vendedor',
    invoiceType: 'A',
    paymentCondition: 'contado',
  });

  assert.equal(draft.ok, true);
  if (!draft.ok) return;

  assert.deepEqual(
    draft.value.order.items.map((item) => item.itemDiscount),
    [15, 0, 7],
  );
});
