/**
 * Pruebas de validación de descuentos, estructura de pedidos/clientes y
 * transiciones de estado. No requieren base de datos: los casos que llegan
 * a la API fallan antes de conectarse a Mongo.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ORDER_STATUSES,
  canTransitionOrderStatus,
  clientSchema,
  createOrderSchema,
  getOrderStatusTransitionError,
  updateOrderSchema,
} from '../lib/validations';
import { PUT as putOrder } from '../app/api/orders/[id]/route';
import { authRequest } from './test-auth-utils';

const VALID_ID = 'a'.repeat(24);
const OTHER_ID = 'b'.repeat(24);

test('createOrderSchema acepta descuentos válidos (0, 100, strings numéricos) y los normaliza', () => {
  const result = createOrderSchema.safeParse({
    clientId: VALID_ID,
    createdBy: 'Vendedor',
    invoiceType: 'A',
    paymentCondition: 'contado',
    items: [
      { productId: OTHER_ID, requestedQuantity: 2, customDiscount: 0 },
      { productId: OTHER_ID, requestedQuantity: 1, customDiscount: 100 },
      { productId: OTHER_ID, requestedQuantity: 1, customDiscount: '25.5' },
      { productId: OTHER_ID, requestedQuantity: 1 },
      { productId: OTHER_ID, requestedQuantity: 1, customDiscount: null },
      { productId: OTHER_ID, requestedQuantity: 1, customDiscount: '' },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.items[0].customDiscount, 0);
    assert.equal(result.data.items[1].customDiscount, 100);
    assert.equal(result.data.items[2].customDiscount, 25.5);
    assert.equal(result.data.items[3].customDiscount, undefined);
    assert.equal(result.data.items[4].customDiscount, undefined);
    assert.equal(result.data.items[5].customDiscount, undefined);
  }
});

test('createOrderSchema rechaza descuentos, IDs y cantidades inválidas', () => {
  const base = {
    clientId: VALID_ID,
    createdBy: 'Vendedor',
    invoiceType: 'A' as const,
    paymentCondition: 'contado' as const,
  };
  const invalidItems = [
    { productId: OTHER_ID, requestedQuantity: 1, customDiscount: -1 },
    { productId: OTHER_ID, requestedQuantity: 1, customDiscount: 100.01 },
    { productId: OTHER_ID, requestedQuantity: 1, customDiscount: 'abc' },
    { productId: OTHER_ID, requestedQuantity: 1, customDiscount: { $gt: 0 } },
    { productId: 'no-es-un-objectid', requestedQuantity: 1 },
    { productId: OTHER_ID, requestedQuantity: 0 },
    { productId: OTHER_ID, requestedQuantity: -3 },
    { productId: OTHER_ID, requestedQuantity: 1.5 },
  ];

  for (const item of invalidItems) {
    const result = createOrderSchema.safeParse({ ...base, items: [item] });
    assert.equal(result.success, false, `debía rechazar el ítem ${JSON.stringify(item)}`);
  }

  assert.equal(
    createOrderSchema.safeParse({
      ...base,
      clientId: 'mal',
      items: [{ productId: OTHER_ID, requestedQuantity: 1 }],
    }).success,
    false,
  );
  assert.equal(createOrderSchema.safeParse({ ...base, items: [] }).success, false);
});

test('createOrderSchema acepta y acota el clientRequestId del alta', () => {
  const base = {
    clientId: VALID_ID,
    invoiceType: 'A' as const,
    paymentCondition: 'contado' as const,
    items: [{ productId: OTHER_ID, requestedQuantity: 1 }],
  };

  const withKey = createOrderSchema.safeParse({
    ...base,
    clientRequestId: ' 7f0f8f5e-7a4d-4a6e-8f1a-2b3c4d5e6f70 ',
  });
  assert.equal(withKey.success, true);
  if (withKey.success) {
    assert.equal(withKey.data.clientRequestId, '7f0f8f5e-7a4d-4a6e-8f1a-2b3c4d5e6f70');
  }

  // La clave es opcional para clientes viejos.
  assert.equal(createOrderSchema.safeParse(base).success, true);

  // Vacía o demasiado larga se rechaza antes de llegar a Mongo.
  assert.equal(createOrderSchema.safeParse({ ...base, clientRequestId: '   ' }).success, false);
  assert.equal(
    createOrderSchema.safeParse({ ...base, clientRequestId: 'x'.repeat(121) }).success,
    false,
  );
});

test('createOrderSchema exige condición de pago y detalle cuando es "Otro"', () => {
  const base = {
    clientId: VALID_ID,
    createdBy: 'Vendedor',
    invoiceType: 'A' as const,
    items: [{ productId: OTHER_ID, requestedQuantity: 1 }],
  };

  // La condición es obligatoria al crear.
  assert.equal(createOrderSchema.safeParse(base).success, false);
  assert.equal(
    createOrderSchema.safeParse({ ...base, paymentCondition: 'tarjeta' }).success,
    false,
  );

  // "Otro" sin detalle (o con espacios) debe fallar.
  assert.equal(createOrderSchema.safeParse({ ...base, paymentCondition: 'otro' }).success, false);
  assert.equal(
    createOrderSchema.safeParse({
      ...base,
      paymentCondition: 'otro',
      paymentConditionDetail: '   ',
    }).success,
    false,
  );
  assert.equal(
    createOrderSchema.safeParse({
      ...base,
      paymentCondition: 'otro',
      paymentConditionDetail: 'x'.repeat(121),
    }).success,
    false,
  );

  // "Otro" con detalle se guarda recortado.
  const other = createOrderSchema.safeParse({
    ...base,
    paymentCondition: 'otro',
    paymentConditionDetail: '  cheque a 30 días  ',
  });
  assert.equal(other.success, true);
  if (other.success) {
    assert.equal(other.data.paymentCondition, 'otro');
    assert.equal(other.data.paymentConditionDetail, 'cheque a 30 días');
  }

  // Contado y cuenta corriente descartan el detalle si vino.
  for (const paymentCondition of ['contado', 'cuenta_corriente'] as const) {
    const result = createOrderSchema.safeParse({
      ...base,
      paymentCondition,
      paymentConditionDetail: 'detalle que debe ignorarse',
    });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.paymentConditionDetail, undefined);
  }
});

test('createOrderSchema exige un tipo de factura A/B válido', () => {
  const base = {
    clientId: VALID_ID,
    createdBy: 'Vendedor',
    paymentCondition: 'contado' as const,
    items: [{ productId: OTHER_ID, requestedQuantity: 1 }],
  };

  assert.equal(createOrderSchema.safeParse(base).success, false);
  assert.equal(createOrderSchema.safeParse({ ...base, invoiceType: 'C' }).success, false);
  assert.equal(createOrderSchema.safeParse({ ...base, invoiceType: 'a' }).success, false);

  for (const invoiceType of ['A', 'B'] as const) {
    const result = createOrderSchema.safeParse({ ...base, invoiceType });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.invoiceType, invoiceType);
  }
});

test('clientSchema valida brandDiscounts con schema real y 0–100', () => {
  const valid = clientSchema.safeParse({
    code: 'C1',
    name: 'Cliente',
    generalDiscount: 10,
    brandDiscounts: [
      { brandId: VALID_ID, discountPercentage: 0 },
      { brandId: OTHER_ID, discountPercentage: 100 },
    ],
  });
  assert.equal(valid.success, true);

  const invalidBrandDiscounts = [
    [{ discountPercentage: 10 }],
    [{ brandId: 'no-es-un-objectid', discountPercentage: 10 }],
    [{ brandId: VALID_ID, discountPercentage: 101 }],
    [{ brandId: VALID_ID, discountPercentage: -1 }],
    [{ brandId: VALID_ID, discountPercentage: '10' }],
    [{ brandId: VALID_ID, discountPercentage: 'abc' }],
    'no-es-un-array',
  ];

  for (const brandDiscounts of invalidBrandDiscounts) {
    const result = clientSchema.safeParse({ code: 'C1', name: 'Cliente', brandDiscounts });
    assert.equal(result.success, false, `debía rechazar ${JSON.stringify(brandDiscounts)}`);
  }

  assert.equal(
    clientSchema.safeParse({ code: 'C1', name: 'Cliente', generalDiscount: 150 }).success,
    false,
  );
  assert.equal(
    clientSchema.safeParse({ code: 'C1', name: 'Cliente', generalDiscount: -1 }).success,
    false,
  );
  assert.equal(
    clientSchema.safeParse({ code: 'C1', name: 'Cliente', generalDiscount: '25' }).success,
    true,
  );
  assert.equal(
    clientSchema.safeParse({ code: 'C1', name: 'Cliente', generalDiscount: '' }).success,
    true,
  );
});

test('updateOrderSchema valida status contra la whitelist y la estructura del body', () => {
  for (const status of ORDER_STATUSES) {
    assert.equal(
      updateOrderSchema.safeParse({ status, version: 0 }).success,
      true,
      `"${status}" debe ser válido`,
    );
  }

  assert.equal(updateOrderSchema.safeParse({ status: 'aprobado', version: 0 }).success, false);
  assert.equal(updateOrderSchema.safeParse({ status: '', version: 0 }).success, false);
  assert.equal(updateOrderSchema.safeParse({ archived: true, version: 0 }).success, true);
  assert.equal(updateOrderSchema.safeParse({ archived: 'true', version: 0 }).success, false);

  // La versión es obligatoria para evitar escrituras last-write-wins.
  assert.equal(updateOrderSchema.safeParse({ status: 'paralizado' }).success, false);
  assert.equal(updateOrderSchema.safeParse({ status: 'paralizado', version: -1 }).success, false);
  assert.equal(updateOrderSchema.safeParse({ status: 'paralizado', version: 1.5 }).success, false);
  assert.equal(updateOrderSchema.safeParse({ status: 'paralizado', version: '0' }).success, false);

  assert.equal(
    updateOrderSchema.safeParse({ items: [{ productId: VALID_ID }], version: 0 }).success,
    true,
  );
  assert.equal(
    updateOrderSchema.safeParse({
      items: [{ _id: VALID_ID, verifiedQuantity: 3, isPending: false }],
      version: 0,
    }).success,
    true,
  );
  assert.equal(
    updateOrderSchema.safeParse({
      items: [{ _id: VALID_ID, verifiedQuantity: 0, isPending: true, pendingReason: 'Sin stock' }],
      version: 0,
    }).success,
    true,
  );
  assert.equal(
    updateOrderSchema.safeParse({
      items: [{ _id: VALID_ID, pendingReason: 'x'.repeat(201) }],
      version: 0,
    }).success,
    false,
  );
  assert.equal(updateOrderSchema.safeParse({ items: [], version: 0 }).success, false);
  assert.equal(updateOrderSchema.safeParse({ items: [{}], version: 0 }).success, false);
  assert.equal(
    updateOrderSchema.safeParse({
      items: [{ productId: VALID_ID, verifiedQuantity: -1 }],
      version: 0,
    }).success,
    false,
  );
  assert.equal(
    updateOrderSchema.safeParse({
      items: [{ productId: VALID_ID, verifiedQuantity: 1.5 }],
      version: 0,
    }).success,
    false,
  );
  assert.equal(
    updateOrderSchema.safeParse({ items: [{ productId: 'mal' }], version: 0 }).success,
    false,
  );
  assert.equal(
    updateOrderSchema.safeParse({ items: [{ productId: VALID_ID, isPending: 'si' }], version: 0 })
      .success,
    false,
  );
});

test('las transiciones de estado respetan el ciclo de vida', () => {
  assert.equal((ORDER_STATUSES as readonly string[]).includes('verificacion'), false);

  assert.equal(canTransitionOrderStatus('borrador', 'paralizado'), true);
  assert.equal(canTransitionOrderStatus('borrador', 'facturacion'), true);
  assert.equal(canTransitionOrderStatus('borrador', 'entregado'), false);

  assert.equal(canTransitionOrderStatus('paralizado', 'facturacion'), true);
  assert.equal(canTransitionOrderStatus('paralizado', 'paralizado'), true);
  assert.equal(canTransitionOrderStatus('paralizado', 'borrador'), false);

  assert.equal(canTransitionOrderStatus('facturacion', 'control_post_factura'), true);
  assert.equal(canTransitionOrderStatus('facturacion', 'entregado'), true);
  assert.equal(canTransitionOrderStatus('facturacion', 'paralizado'), false);

  assert.equal(canTransitionOrderStatus('control_post_factura', 'entregado'), true);
  assert.equal(canTransitionOrderStatus('control_post_factura', 'facturacion'), false);

  assert.equal(canTransitionOrderStatus('entregado', 'facturacion'), false);
  assert.equal(canTransitionOrderStatus('entregado', 'entregado'), true);

  assert.equal(
    getOrderStatusTransitionError('entregado', 'facturacion'),
    'Transición de estado inválida: no se puede pasar de "entregado" a "facturacion"',
  );
  assert.equal(getOrderStatusTransitionError('borrador', 'paralizado'), null);
});

test('PUT /api/orders/[id] responde 400 (no 500) ante datos inválidos', async () => {
  const invalidRequests: Array<{ label: string; body: string }> = [
    { label: 'JSON malformado', body: '{esto-no-es-json' },
    {
      label: 'status fuera de la whitelist',
      body: JSON.stringify({ status: 'aprobado', version: 0 }),
    },
    { label: 'status vacío', body: JSON.stringify({ status: '', version: 0 }) },
    { label: 'archived no booleano', body: JSON.stringify({ archived: 'true', version: 0 }) },
    { label: 'items vacíos', body: JSON.stringify({ items: [], version: 0 }) },
    {
      label: 'verifiedQuantity negativa',
      body: JSON.stringify({ items: [{ productId: OTHER_ID, verifiedQuantity: -1 }], version: 0 }),
    },
    {
      label: 'productId inválido',
      body: JSON.stringify({ items: [{ productId: 'x' }], version: 0 }),
    },
    { label: 'ítem sin identificadores', body: JSON.stringify({ items: [{}], version: 0 }) },
  ];

  for (const { label, body } of invalidRequests) {
    const request = authRequest(
      `http://localhost/api/orders/${VALID_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      'controlador',
    );

    const response = await putOrder(request, { params: Promise.resolve({ id: VALID_ID }) });
    assert.equal(response.status, 400, `${label}: se esperaba 400 y llegó ${response.status}`);

    const payload = await response.json();
    assert.ok(payload.error, `${label}: la respuesta debe incluir un mensaje de error`);
  }

  const badIdRequest = authRequest(
    'http://localhost/api/orders/id-invalido',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'facturacion' }),
    },
    'controlador',
  );
  const badIdResponse = await putOrder(badIdRequest, {
    params: Promise.resolve({ id: 'id-invalido' }),
  });
  assert.equal(
    badIdResponse.status,
    400,
    `id inválido: se esperaba 400 y llegó ${badIdResponse.status}`,
  );
});
