/**
 * Pruebas de la precarga del carrito (lib/order-prefill.ts).
 *
 * El caso principal es repetir un pedido con el resumen liviano que ya devuelve
 * el listado (`OrderSummaryDTO`, con `items.productId` escalar): no debe
 * necesitar un segundo GET del detalle para armar cantidades y datos
 * comerciales, y debe conservar los descuentos de la ficha conocida del cliente.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOrderPrefill, orderItemProductId } from '../lib/order-prefill';
import type { OrderCatalogClient } from '../lib/order-catalog';
import type { OrderDTO, OrderSummaryDTO } from '../lib/types';

const CLIENT_ID = 'client-1';

const knownClient: OrderCatalogClient = {
  _id: CLIENT_ID,
  code: 'CLI-1',
  name: 'Farmacia Uno',
  address: 'Calle 123',
  localidad: 'CABA',
  province: 'Buenos Aires',
  generalDiscount: 7,
  brandDiscounts: [{ brandId: 'brand-1', discountPercentage: 12 }],
};

const summary: OrderSummaryDTO = {
  _id: 'order-1',
  clientId: { _id: CLIENT_ID, code: 'CLI-1', name: 'Farmacia Uno', localidad: 'CABA' },
  clientName: 'Farmacia Uno',
  clientCode: 'CLI-1',
  status: 'borrador',
  finalTotal: 4_235,
  createdBy: 'vendedor',
  createdAt: '2026-01-05T10:00:00.000Z',
  invoiceType: 'B',
  paymentCondition: 'cuenta_corriente',
  paymentConditionDetail: '',
  items: [
    {
      _id: 'line-1',
      productId: 'product-1',
      productName: 'Shampoo',
      productCode: 'P1',
      requestedQuantity: 2,
      verifiedQuantity: 2,
      isPending: false,
    },
    {
      _id: 'line-2',
      productId: 'product-2',
      productName: 'Acondicionador',
      productCode: 'P2',
      requestedQuantity: 1,
    },
    {
      _id: 'line-3',
      productId: 'product-1',
      productName: 'Shampoo',
      productCode: 'P1',
      requestedQuantity: 1,
    },
  ],
};

test('buildOrderPrefill arma el carrito desde un OrderSummaryDTO sin segundo fetch', () => {
  const prefill = buildOrderPrefill(summary, [knownClient]);

  assert.deepEqual(prefill.quantities, {
    'product-1': 3,
    'product-2': 1,
  });
  assert.deepEqual(prefill.omittedItems, []);
  assert.equal(prefill.invoiceType, 'B');
  assert.equal(prefill.paymentCondition, 'cuenta_corriente');
  assert.equal(prefill.paymentConditionDetail, '');

  // El resumen del cliente no trae dirección ni descuentos: se completan con
  // la ficha ya conocida por el alta, sin otra consulta.
  assert.equal(prefill.client?._id, CLIENT_ID);
  assert.equal(prefill.client?.code, 'CLI-1');
  assert.equal(prefill.client?.name, 'Farmacia Uno');
  assert.equal(prefill.client?.address, 'Calle 123');
  assert.equal(prefill.client?.localidad, 'CABA');
  assert.equal(prefill.client?.generalDiscount, 7);
  assert.deepEqual(prefill.client?.brandDiscounts, [
    { brandId: 'brand-1', discountPercentage: 12 },
  ]);
});

test('el cliente ya seleccionado gana sobre la ficha buscada por código', () => {
  const selectedClient: OrderCatalogClient = {
    ...knownClient,
    address: 'Dirección vigente 456',
    generalDiscount: 10,
  };

  const prefill = buildOrderPrefill(summary, [knownClient], selectedClient);

  assert.equal(prefill.client?.address, 'Dirección vigente 456');
  assert.equal(prefill.client?.generalDiscount, 10);
  assert.equal(prefill.client?.name, 'Farmacia Uno');
});

test('una línea sin productId se reporta y no inventa cantidades', () => {
  const prefill = buildOrderPrefill(
    {
      ...summary,
      items: [
        {
          _id: 'legacy-line',
          productName: 'Producto histórico',
          productCode: 'OLD-1',
          requestedQuantity: 4,
        },
        {
          _id: 'line-1',
          productId: 'product-1',
          requestedQuantity: 1,
        },
      ],
    },
    [knownClient],
  );

  assert.deepEqual(prefill.quantities, { 'product-1': 1 });
  assert.deepEqual(prefill.omittedItems, [
    {
      productId: '',
      productCode: 'OLD-1',
      productName: 'Producto histórico',
      requestedQuantity: 4,
      reason: 'not_found',
    },
  ]);
});

test('el detalle completo sigue omitiendo productos inactivos', () => {
  const detail: OrderDTO = {
    _id: 'order-detail',
    clientId: {
      _id: CLIENT_ID,
      code: 'CLI-1',
      name: 'Farmacia Uno',
      address: 'Calle 123',
      generalDiscount: 7,
    },
    status: 'borrador',
    subtotal: 700,
    totalDiscount: 0,
    finalTotal: 700,
    createdBy: 'vendedor',
    createdAt: '2026-01-05T10:00:00.000Z',
    invoiceType: 'A',
    paymentCondition: 'contado',
    items: [
      {
        _id: 'line-1',
        productId: {
          _id: 'product-1',
          code: 'P1',
          name: 'Shampoo activo',
          price: 100,
          active: true,
        },
        unitPrice: 100,
        requestedQuantity: 2,
        verifiedQuantity: 2,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 200,
      },
      {
        _id: 'line-2',
        productId: {
          _id: 'product-2',
          code: 'P2',
          name: 'Shampoo inactivo',
          price: 100,
          active: false,
        },
        unitPrice: 100,
        requestedQuantity: 5,
        verifiedQuantity: 5,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 500,
      },
    ],
  };

  const prefill = buildOrderPrefill(detail);

  assert.deepEqual(prefill.quantities, { 'product-1': 2 });
  assert.equal(prefill.omittedItems[0]?.productId, 'product-2');
  assert.equal(prefill.omittedItems[0]?.reason, 'inactive');
  assert.equal(prefill.client?.address, 'Calle 123');
});

test('orderItemProductId acepta la referencia escalar y el producto poblado', () => {
  assert.equal(orderItemProductId({ productId: 'product-1' }), 'product-1');
  assert.equal(
    orderItemProductId({
      productId: {
        _id: 'product-2',
        code: 'P2',
        name: 'Producto',
        price: 100,
      },
    }),
    'product-2',
  );
  assert.equal(orderItemProductId({}), '');
  assert.equal(orderItemProductId({ productId: null }), '');
});
