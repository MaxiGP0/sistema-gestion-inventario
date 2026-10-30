/**
 * Pruebas de la capa de dominio de pedidos (`lib/services/orders.ts`).
 *
 * Son funciones puras: no requieren MongoDB, mongoose, Next ni mocks de la
 * capa HTTP. Cubren alta, picking, totales, guards de estado y notificaciones.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyOrderUpdatePlan,
  buildDraftOrderNotification,
  buildReadyForBillingNotification,
  buildVendorCommentNotification,
  collectNewProductIds,
  collectRequestedProductIds,
  createOrderDraft,
  DRAFT_EDIT_BLOCKED_ERROR,
  DRAFT_EDIT_INACTIVE_PRODUCT_ERROR,
  isDraftOrderIntact,
  ORDER_VERSION_CONFLICT_CODE,
  PENDING_ITEMS_BLOCK_ERROR,
  planOrderUpdate,
  planPostControlUpdates,
  UNCONTROLLED_POST_ITEMS_BLOCK_ERROR,
  type ExistingOrderInput,
} from '../lib/services/orders';
import { formatInvoiceType, formatPaymentCondition } from '../lib/order-commercial';
import { buildOrderPrefill, buildPrefillOmittedMessage } from '../lib/order-prefill';
import type { OrderDTO } from '../lib/types';

const oid = (char: string) => char.repeat(24);

const client = {
  code: 'CLI-1',
  name: 'Cliente Demo',
  generalDiscount: 10,
  brandDiscounts: [{ brandId: { _id: 'b'.repeat(24) }, discountPercentage: '25' }],
};

const products = [
  {
    _id: oid('1'),
    code: 'P-1',
    name: 'Producto Uno',
    price: 100,
    brandId: { _id: 'b'.repeat(24), name: 'Marca B' },
  },
  {
    _id: oid('2'),
    code: 'P-2',
    name: 'Producto Dos',
    price: 50,
    brandId: oid('c'),
  },
];

const existingItem = (overrides: Record<string, unknown> = {}) => ({
  _id: oid('a'),
  productId: oid('9'),
  productCode: 'OLD-1',
  productName: 'Producto Existente',
  brandName: 'Marca Existente',
  unitPrice: 100,
  requestedQuantity: 5,
  verifiedQuantity: 5,
  isPending: false,
  itemDiscount: 10,
  postControl: 'ok' as const,
  lineTotal: 450,
  ...overrides,
});

const order = (overrides: Partial<ExistingOrderInput> = {}): ExistingOrderInput => ({
  version: 0,
  status: 'borrador',
  clientName: 'Cliente Demo',
  clientCode: 'CLI-1',
  items: [existingItem()],
  comments: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

test('createOrderDraft arma snapshots, descuentos y totales del alta', () => {
  const now = new Date('2026-01-02T03:04:05Z');
  const result = createOrderDraft({
    clientId: oid('0'),
    client,
    products,
    items: [
      { productId: oid('1'), requestedQuantity: 2 },
      { productId: oid('2'), requestedQuantity: 3, customDiscount: 0 },
      // Producto inexistente: se omite sin romper el alta.
      { productId: oid('f'), requestedQuantity: 5 },
    ],
    createdBy: 'vendedor',
    comment: '  Entregar por la tarde  ',
    invoiceType: 'A',
    paymentCondition: 'contado',
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { order: draft, notification } = result.value;

  assert.equal(draft.status, 'borrador');
  assert.equal(draft.clientId, oid('0'));
  assert.equal(draft.clientName, 'Cliente Demo');
  assert.equal(draft.clientCode, 'CLI-1');
  assert.equal(draft.invoiceType, 'A');
  assert.equal(draft.paymentCondition, 'contado');
  assert.equal(draft.paymentConditionDetail, undefined);
  assert.equal(draft.items.length, 2);

  const [first, second] = draft.items;
  assert.deepEqual(
    {
      productId: first.productId,
      productCode: first.productCode,
      productName: first.productName,
      brandName: first.brandName,
      unitPrice: first.unitPrice,
      requestedQuantity: first.requestedQuantity,
      verifiedQuantity: first.verifiedQuantity,
      itemDiscount: first.itemDiscount,
      lineTotal: first.lineTotal,
    },
    {
      productId: oid('1'),
      productCode: 'P-1',
      productName: 'Producto Uno',
      brandName: 'Marca B',
      unitPrice: 100,
      requestedQuantity: 2,
      verifiedQuantity: 0,
      itemDiscount: 25, // marca (25) pisa al general (10)
      lineTotal: 150,
    },
  );

  // customDiscount 0 es un descuento propio válido: no cae al general.
  assert.equal(second.itemDiscount, 0);
  assert.equal(second.lineTotal, 150);

  assert.equal(draft.subtotal, 350);
  assert.equal(draft.totalDiscount, 50);
  assert.equal(draft.finalTotal, 300);
  assert.deepEqual(draft.comments, [
    { text: 'Entregar por la tarde', author: 'vendedor', role: 'vendedor', createdAt: now },
  ]);

  assert.deepEqual(notification, {
    title: 'Nuevo Pedido (Borrador)',
    message: 'El vendedor vendedor creó un pedido para Cliente Demo por $300.00',
    targetRole: 'deposit',
  });
});

test('createOrderDraft rechaza cliente inexistente y pedidos sin líneas válidas', () => {
  const base = {
    clientId: oid('0'),
    products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    createdBy: 'vendedor',
    invoiceType: 'A' as const,
    paymentCondition: 'contado' as const,
  };

  const missingClient = createOrderDraft({ ...base, client: null });
  assert.equal(missingClient.ok, false);
  if (!missingClient.ok) {
    assert.equal(missingClient.status, 404);
    assert.match(missingClient.message, /cliente no encontrado/i);
  }

  const noProducts = createOrderDraft({
    ...base,
    client,
    items: [
      { productId: oid('f'), requestedQuantity: 2 },
      { productId: oid('1'), requestedQuantity: 0 },
      { productId: oid('1'), requestedQuantity: Number.NaN },
    ],
  });
  assert.equal(noProducts.ok, false);
  if (!noProducts.ok) {
    assert.equal(noProducts.status, 400);
    assert.match(noProducts.message, /cantidades mayores a 0/i);
  }
});

test('createOrderDraft persiste "Otro" con detalle y limpia el detalle en las demás condiciones', () => {
  const base = {
    clientId: oid('0'),
    client,
    products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    createdBy: 'vendedor',
    invoiceType: 'B' as const,
  };

  const other = createOrderDraft({
    ...base,
    paymentCondition: 'otro',
    paymentConditionDetail: '  cheque a 30 días  ',
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal(other.value.order.invoiceType, 'B');
  assert.equal(other.value.order.paymentCondition, 'otro');
  assert.equal(other.value.order.paymentConditionDetail, 'cheque a 30 días');

  const cash = createOrderDraft({
    ...base,
    paymentCondition: 'contado',
    paymentConditionDetail: 'este detalle debe ignorarse',
  });
  assert.equal(cash.ok, true);
  if (!cash.ok) return;
  assert.equal(cash.value.order.invoiceType, 'B');
  assert.equal(cash.value.order.paymentCondition, 'contado');
  assert.equal(cash.value.order.paymentConditionDetail, undefined);
});

test('formatPaymentCondition muestra el detalle solo para "Otro" y cubre pedidos viejos', () => {
  assert.equal(formatPaymentCondition(undefined), 'No informado');
  assert.equal(formatPaymentCondition('condicion-invalida'), 'No informado');
  assert.equal(formatPaymentCondition('contado', 'detalle ignorado'), 'Contado');
  assert.equal(formatPaymentCondition('cuenta_corriente'), 'Cuenta corriente');
  assert.equal(formatPaymentCondition('otro', '  cheque a 30 días  '), 'Otro — cheque a 30 días');
  assert.equal(formatPaymentCondition('otro'), 'Otro');
});

test('formatInvoiceType muestra Factura A/B y cae en "No informado" para pedidos viejos', () => {
  assert.equal(formatInvoiceType('A'), 'Factura A');
  assert.equal(formatInvoiceType('B'), 'Factura B');
  assert.equal(formatInvoiceType(undefined), 'No informado');
  assert.equal(formatInvoiceType(null), 'No informado');
  assert.equal(formatInvoiceType('C'), 'No informado');
});

test('collectRequestedProductIds deduplica y descarta cantidades no positivas', () => {
  assert.deepEqual(
    collectRequestedProductIds([
      { productId: oid('1'), requestedQuantity: 2 },
      { productId: oid('1'), requestedQuantity: 3 },
      { productId: oid('2'), requestedQuantity: 0 },
      { productId: oid('3'), requestedQuantity: 1 },
    ]),
    [oid('1'), oid('3')],
  );
});

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

test('planOrderUpdate conserva snapshot/descuento del existente y agrega líneas del catálogo', () => {
  const existing = existingItem();
  const result = planOrderUpdate({
    order: order({ items: [existing] }),
    client,
    catalogProducts: products,
    items: [
      { _id: existing._id, verifiedQuantity: 3, isPending: false },
      { productId: oid('2'), requestedQuantity: 4, verifiedQuantity: 2 },
    ],
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const [kept, added] = result.value.items!;

  assert.equal(kept._id, existing._id, 'conserva la identidad de la línea');
  assert.equal(kept.productCode, 'OLD-1');
  assert.equal(kept.unitPrice, 100);
  assert.equal(kept.itemDiscount, 10, 'conserva el descuento congelado del alta');
  assert.equal(kept.verifiedQuantity, 3);
  assert.equal(kept.lineTotal, 270);
  assert.equal(kept.postControl, 'ok', 'conserva el control post-factura');

  assert.equal(added.productCode, 'P-2');
  assert.equal(added.unitPrice, 50);
  assert.equal(added.requestedQuantity, 4);
  assert.equal(added.verifiedQuantity, 2);
  assert.equal(added.itemDiscount, 10, 'sin marca configurada rige el general');
  assert.equal(added.lineTotal, 90);

  // 3 de 5 controlados: el pedido queda paralizado y avisa al vendedor.
  assert.equal(result.value.status, 'paralizado');
  assert.deepEqual(result.value.notification, {
    title: 'Pedido Paralizado en Depósito',
    message: 'El pedido de Cliente Demo quedó paralizado en depósito.',
    targetRole: 'vendor',
  });
  assert.equal(result.value.subtotal, 400);
  assert.equal(result.value.totalDiscount, 40);
  assert.equal(result.value.finalTotal, 360);
});

test('collectNewProductIds solo pide al catálogo las líneas nuevas', () => {
  const existing = existingItem();

  assert.deepEqual(
    collectNewProductIds({ items: [existing] }, [
      { _id: existing._id, verifiedQuantity: 5 },
      { productId: oid('2'), verifiedQuantity: 1 },
      { productId: oid('2'), verifiedQuantity: 2 },
      { _id: oid('f'), verifiedQuantity: 1 },
    ]),
    [oid('2')],
  );
});

test('un ítem quitado en depósito se conserva pendiente, con motivo y sin sumar', () => {
  const kept = existingItem();
  const removed = existingItem({
    _id: oid('e'),
    productId: oid('8'),
    productCode: 'OLD-2',
    productName: 'Producto Quitado',
    requestedQuantity: 2,
    lineTotal: 180,
  });

  const result = planOrderUpdate({
    order: order({ items: [kept, removed] }),
    client,
    items: [{ _id: kept._id, verifiedQuantity: 5, isPending: false }],
    status: 'paralizado',
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.items!.length, 2);
  const preserved = result.value.items!.find((item) => item.productCode === 'OLD-2')!;
  assert.equal(preserved._id, removed._id);
  assert.equal(preserved.verifiedQuantity, 0);
  assert.equal(preserved.isPending, true);
  assert.equal(preserved.pendingReason, 'Eliminado en depósito');
  assert.equal(preserved.lineTotal, 0);
  assert.equal(result.value.subtotal, 500, 'la línea quitada no suma al total');
  assert.equal(result.value.finalTotal, 450);
  assert.equal(result.value.status, 'paralizado');
});

test('picking completo sin estado explícito pasa a facturación y notifica', () => {
  const result = planOrderUpdate({
    order: order(),
    client,
    items: [{ _id: oid('a'), verifiedQuantity: 5, isPending: false }],
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'facturacion');
  assert.deepEqual(result.value.notification, {
    title: 'Pedido Listo para Facturar',
    message: 'El pedido de Cliente Demo ha sido verificado en depósito y está listo para facturar.',
    targetRole: 'billing',
  });
});

test('un pedido que ya estaba en facturación no vuelve a notificar', () => {
  const result = planOrderUpdate({
    order: order({ status: 'facturacion' }),
    client,
    items: [{ _id: oid('a'), verifiedQuantity: 5, isPending: false }],
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, 'facturacion');
  assert.equal(result.value.notification, null);
});

test('rechaza versiones viejas con el mismo contrato que la API', () => {
  const result = planOrderUpdate({
    order: order({ version: 3 }),
    client,
    status: 'paralizado',
    version: 2,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.code, ORDER_VERSION_CONFLICT_CODE);
    assert.deepEqual(result.extras, { version: 3 });
    assert.match(result.message, /conflicto de versión/i);
  }
});

test('un ítem nuevo sin productId se rechaza como huérfano', () => {
  const result = planOrderUpdate({
    order: order(),
    client,
    items: [{ _id: oid('f'), verifiedQuantity: 1 }],
    version: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.message, /productId/);
  }
});

test('facturación con faltantes se bloquea con 409', () => {
  const partial = planOrderUpdate({
    order: order(),
    client,
    items: [{ _id: oid('a'), verifiedQuantity: 3, isPending: false }],
    status: 'facturacion',
    version: 0,
  });

  assert.equal(partial.ok, false);
  if (!partial.ok) {
    assert.equal(partial.status, 409);
    assert.equal(partial.message, PENDING_ITEMS_BLOCK_ERROR);
  }

  // También al pedir solo el cambio de estado, sin reenviar ítems.
  const onlyStatus = planOrderUpdate({
    order: order({ items: [existingItem({ verifiedQuantity: 2 })] }),
    client,
    status: 'facturacion',
    version: 0,
  });

  assert.equal(onlyStatus.ok, false);
  if (!onlyStatus.ok) {
    assert.equal(onlyStatus.status, 409);
    assert.equal(onlyStatus.message, PENDING_ITEMS_BLOCK_ERROR);
  }
});

test('la entrega se bloquea si queda alguna línea sin controlar', () => {
  const result = planOrderUpdate({
    order: order({
      status: 'control_post_factura',
      items: [
        existingItem({ postControl: 'ok' }),
        existingItem({ _id: oid('b'), productId: oid('7'), postControl: 'pendiente' }),
      ],
    }),
    client,
    status: 'entregado',
    version: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.message, UNCONTROLLED_POST_ITEMS_BLOCK_ERROR);
  }

  const delivered = planOrderUpdate({
    order: order({
      status: 'control_post_factura',
      items: [
        existingItem({ postControl: 'ok' }),
        existingItem({ _id: oid('b'), productId: oid('7'), postControl: 'diferencia' }),
      ],
    }),
    client,
    status: 'entregado',
    version: 0,
  });
  assert.equal(delivered.ok, true);
});

test('el comentario se recorta y usa el estado destino como rol por defecto', () => {
  const result = planOrderUpdate({
    order: order(),
    client,
    items: [{ _id: oid('a'), verifiedQuantity: 5, isPending: false }],
    comment: '  controlado  ',
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.comment?.text, 'controlado');
  assert.equal(result.value.comment?.author, 'Operario / Sistema');
  assert.equal(result.value.comment?.role, 'facturacion');
});

test('un comentario del vendedor en borrador avisa a depósito', () => {
  const now = new Date('2026-02-03T04:05:06Z');
  const result = planOrderUpdate({
    order: order(),
    client,
    comment: '  Enviar lo disponible  ',
    author: 'e2e-vendedor',
    role: 'vendedor',
    version: 0,
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'borrador');
  assert.deepEqual(result.value.comment, {
    text: 'Enviar lo disponible',
    author: 'e2e-vendedor',
    role: 'vendedor',
    createdAt: now,
  });
  assert.deepEqual(
    result.value.notification,
    buildVendorCommentNotification({
      author: 'e2e-vendedor',
      clientName: 'Cliente Demo',
      comment: 'Enviar lo disponible',
    }),
  );
  assert.equal(result.value.notification?.title, 'Nuevo comentario en pedido');
  assert.equal(result.value.notification?.targetRole, 'deposit');
  assert.match(result.value.notification?.message ?? '', /Cliente Demo/);
  assert.match(result.value.notification?.message ?? '', /e2e-vendedor/);
});

test('un comentario del vendedor en un pedido paralizado avisa a depósito', () => {
  const result = planOrderUpdate({
    order: order({ status: 'paralizado' }),
    client,
    comment: 'Cliente espera faltante',
    author: 'e2e-vendedor',
    role: 'vendedor',
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'paralizado');
  assert.equal(result.value.comment?.role, 'vendedor');
  assert.equal(result.value.notification?.targetRole, 'deposit');
  assert.equal(result.value.notification?.title, 'Nuevo comentario en pedido');
});

test('los comentarios operativos avisan al vendedor solo si el PUT no emitió otra alerta', () => {
  const transition = planOrderUpdate({
    order: order(),
    client,
    items: [{ _id: oid('a'), verifiedQuantity: 5, isPending: false }],
    comment: 'Listo para facturar',
    author: 'e2e-vendedor',
    role: 'vendedor',
    version: 0,
  });

  assert.equal(transition.ok, true);
  if (!transition.ok) return;
  assert.equal(transition.value.status, 'facturacion');
  assert.equal(transition.value.notification?.targetRole, 'billing');
  assert.equal(transition.value.notification?.title, 'Pedido Listo para Facturar');

  const depositComment = planOrderUpdate({
    order: order({
      status: 'paralizado',
      createdById: oid('d'),
      createdBy: 'e2e-vendedor',
    }),
    client,
    comment: 'Sin stock temporal',
    author: 'e2e-deposito',
    role: 'controlador',
    version: 0,
  });

  assert.equal(depositComment.ok, true);
  if (!depositComment.ok) return;
  assert.equal(depositComment.value.notification?.targetRole, 'vendor');
  assert.equal(depositComment.value.notification?.title, 'Nuevo comentario en tu pedido');
  assert.equal(depositComment.value.notification?.targetUserId, oid('d'));
  assert.equal(depositComment.value.notification?.targetUsername, 'e2e-vendedor');

  const billingStageComment = planOrderUpdate({
    order: order({ status: 'facturacion' }),
    client,
    comment: 'Revisar precio',
    author: 'e2e-vendedor',
    role: 'vendedor',
    version: 0,
  });

  assert.equal(billingStageComment.ok, true);
  if (!billingStageComment.ok) return;
  assert.equal(billingStageComment.value.notification, null);
});

test('paralizar un pedido avisa de forma privada al vendedor con el motivo', () => {
  const result = planOrderUpdate({
    order: order({ createdById: oid('d'), createdBy: 'e2e-vendedor' }),
    client,
    status: 'paralizado',
    comment: 'Falta stock del segundo producto',
    author: 'e2e-deposito',
    role: 'controlador',
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'paralizado');
  assert.deepEqual(result.value.notification, {
    title: 'Pedido Paralizado en Depósito',
    message:
      'El pedido de Cliente Demo quedó paralizado en depósito: Falta stock del segundo producto',
    targetRole: 'vendor',
    targetUserId: oid('d'),
    targetUsername: 'e2e-vendedor',
  });
});

test('entregar un pedido avisa de forma privada al vendedor titular', () => {
  const result = planOrderUpdate({
    order: order({
      status: 'control_post_factura',
      items: [existingItem({ postControl: 'ok' })],
      createdById: oid('d'),
      createdBy: 'e2e-vendedor',
    }),
    client,
    status: 'entregado',
    author: 'e2e-facturacion',
    role: 'billing',
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'entregado');
  assert.deepEqual(result.value.notification, {
    title: 'Pedido Entregado',
    message: 'El pedido de Cliente Demo fue entregado.',
    targetRole: 'vendor',
    targetUserId: oid('d'),
    targetUsername: 'e2e-vendedor',
  });
});

test('applyOrderUpdatePlan vuelca el plan en el documento y agrega el comentario', () => {
  const target: any = {
    status: 'borrador',
    items: [existingItem()],
    comments: [],
  };

  const result = planOrderUpdate({
    order: order(),
    client,
    items: [{ _id: oid('a'), verifiedQuantity: 5, isPending: false }],
    comment: 'ok',
    archived: true,
    version: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  applyOrderUpdatePlan(target, result.value);

  assert.equal(target.status, 'facturacion');
  assert.equal(target.archived, true);
  assert.equal(target.items.length, 1);
  assert.equal(target.subtotal, 500);
  assert.equal(target.finalTotal, 450);
  assert.equal(target.comments.length, 1);
  assert.equal(target.comments[0].text, 'ok');
  assert.deepEqual(target.searchTokens, [
    'cliente',
    'demo',
    'cli',
    '1',
    'old',
    'producto',
    'existente',
    'marca',
  ]);
});

// ---------------------------------------------------------------------------
// Precarga del carrito
// ---------------------------------------------------------------------------

test('buildOrderPrefill suma líneas repetidas y avisa las inactivas o inexistentes', () => {
  const orderDto: OrderDTO = {
    _id: oid('f'),
    status: 'borrador',
    subtotal: 0,
    totalDiscount: 0,
    finalTotal: 0,
    createdBy: 'vendedor',
    createdAt: '2026-01-02T03:04:05.000Z',
    invoiceType: 'A',
    paymentCondition: 'contado',
    clientId: {
      _id: oid('0'),
      code: 'CLI-1',
      name: 'Cliente Demo',
      address: '',
      generalDiscount: 10,
      brandDiscounts: [],
    },
    items: [
      {
        _id: oid('1'),
        productId: {
          _id: oid('1'),
          code: 'P-1',
          name: 'Producto Uno',
          price: 100,
          active: true,
          brandId: { _id: 'b'.repeat(24), name: 'Marca B' },
        },
        unitPrice: 100,
        requestedQuantity: 2,
        verifiedQuantity: 0,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 200,
      },
      {
        _id: oid('2'),
        productId: {
          _id: oid('2'),
          code: 'P-2',
          name: 'Producto Inactivo',
          price: 50,
          active: false,
          brandId: { _id: 'b'.repeat(24), name: 'Marca B' },
        },
        unitPrice: 50,
        requestedQuantity: 4,
        verifiedQuantity: 0,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 200,
      },
      {
        _id: oid('3'),
        productId: {
          _id: oid('1'),
          code: 'P-1',
          name: 'Producto Uno',
          price: 100,
          active: true,
          brandId: { _id: 'b'.repeat(24), name: 'Marca B' },
        },
        unitPrice: 100,
        requestedQuantity: 1,
        verifiedQuantity: 0,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 100,
      },
      {
        _id: oid('4'),
        productId: null,
        productCode: 'BORRADO',
        productName: 'Producto eliminado',
        unitPrice: 75,
        requestedQuantity: 1,
        verifiedQuantity: 0,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 75,
      },
    ],
  };

  const prefill = buildOrderPrefill(orderDto);

  // Dos líneas del mismo producto se suman; las inactivas/inexistentes no.
  assert.deepEqual(prefill.quantities, { [oid('1')]: 3 });
  assert.equal(prefill.client?.code, 'CLI-1');
  assert.equal(prefill.invoiceType, 'A');
  assert.equal(prefill.paymentCondition, 'contado');
  assert.deepEqual(
    prefill.omittedItems.map((item) => [item.productCode, item.reason]),
    [
      ['P-2', 'inactive'],
      ['BORRADO', 'not_found'],
    ],
  );

  const message = buildPrefillOmittedMessage(prefill.omittedItems);
  assert.ok(message);
  assert.match(message, /Se omitieron 2 producto\(s\)/);
  assert.match(message, /P-2 \(inactivo\)/);
});

// ---------------------------------------------------------------------------
// Edición de borradores
// ---------------------------------------------------------------------------

const intactDraftItem = (overrides: Record<string, unknown> = {}) =>
  existingItem({
    verifiedQuantity: 0,
    isPending: false,
    pendingReason: undefined,
    postControl: 'pendiente',
    ...overrides,
  });

test('la edición de un borrador intacto reemplaza líneas con precios y descuentos vigentes', () => {
  const result = planOrderUpdate({
    order: order({ version: 2, items: [intactDraftItem()] }),
    client,
    catalogProducts: products,
    items: [
      { productId: oid('1'), requestedQuantity: 2 },
      { productId: oid('2'), requestedQuantity: 3, customDiscount: 0 },
    ],
    draftEdit: true,
    invoiceType: 'B',
    paymentCondition: 'cuenta_corriente',
    version: 2,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'borrador');
  assert.equal(result.value.notification, null);
  assert.equal(result.value.items!.length, 2);

  const [first, second] = result.value.items!;
  assert.equal(first.productId, oid('1'));
  assert.equal(first.productCode, 'P-1');
  assert.equal(first.unitPrice, 100);
  assert.equal(first.requestedQuantity, 2);
  assert.equal(first.verifiedQuantity, 0);
  assert.equal(first.itemDiscount, 25, 'usa el descuento vigente de la marca');
  assert.equal(first.lineTotal, 150);

  // Un descuento manual 0 sigue siendo válido: no cae al general.
  assert.equal(second.productCode, 'P-2');
  assert.equal(second.itemDiscount, 0);
  assert.equal(second.lineTotal, 150);

  assert.equal(result.value.subtotal, 350);
  assert.equal(result.value.totalDiscount, 50);
  assert.equal(result.value.finalTotal, 300);
  assert.equal(result.value.invoiceType, 'B');
  assert.equal(result.value.paymentCondition, 'cuenta_corriente');
  assert.equal(result.value.paymentConditionDetail, null);
});

test('la edición del borrador descarta las líneas que ya no están en el carrito', () => {
  const removed = intactDraftItem({
    _id: oid('e'),
    productId: oid('2'),
    productCode: 'P-2',
    requestedQuantity: 4,
  });

  const result = planOrderUpdate({
    order: order({ items: [intactDraftItem(), removed] }),
    client,
    catalogProducts: products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    draftEdit: true,
    invoiceType: 'A',
    paymentCondition: 'contado',
    version: 0,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.items!.length, 1);
  assert.equal(result.value.items![0].productId, oid('1'));
  assert.equal(result.value.subtotal, 100);
  assert.equal(result.value.finalTotal, 75);
});

test('la edición del borrador responde 409 si el pedido ya cambió de estado', () => {
  for (const status of ['paralizado', 'facturacion'] as const) {
    const result = planOrderUpdate({
      order: order({ status, items: [intactDraftItem()] }),
      client,
      catalogProducts: products,
      items: [{ productId: oid('1'), requestedQuantity: 1 }],
      draftEdit: true,
      invoiceType: 'A',
      paymentCondition: 'contado',
      version: 0,
    });

    assert.equal(result.ok, false, `"${status}" no debe permitir editar el borrador`);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.message, DRAFT_EDIT_BLOCKED_ERROR);
    }
  }
});

test('la edición del borrador responde 409 si depósito ya inició el picking o el control', () => {
  const pickingStarted = planOrderUpdate({
    order: order({ items: [intactDraftItem({ verifiedQuantity: 1 })] }),
    client,
    catalogProducts: products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    draftEdit: true,
    invoiceType: 'A',
    paymentCondition: 'contado',
    version: 0,
  });

  assert.equal(pickingStarted.ok, false);
  if (!pickingStarted.ok) {
    assert.equal(pickingStarted.status, 409);
    assert.equal(pickingStarted.message, DRAFT_EDIT_BLOCKED_ERROR);
  }

  const postControlled = planOrderUpdate({
    order: order({ items: [intactDraftItem({ postControl: 'ok' })] }),
    client,
    catalogProducts: products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    draftEdit: true,
    invoiceType: 'A',
    paymentCondition: 'contado',
    version: 0,
  });

  assert.equal(postControlled.ok, false);
  if (!postControlled.ok) {
    assert.equal(postControlled.status, 409);
    assert.equal(postControlled.message, DRAFT_EDIT_BLOCKED_ERROR);
  }
});

test('isDraftOrderIntact exige borrador, cantidades sin verificar y sin post-control', () => {
  assert.equal(isDraftOrderIntact(order({ items: [intactDraftItem()] })), true);
  assert.equal(
    isDraftOrderIntact(order({ status: 'paralizado', items: [intactDraftItem()] })),
    false,
  );
  assert.equal(
    isDraftOrderIntact(order({ items: [intactDraftItem({ verifiedQuantity: 1 })] })),
    false,
  );
  assert.equal(
    isDraftOrderIntact(order({ items: [intactDraftItem({ postControl: 'diferencia' })] })),
    false,
  );
});

test('la edición del borrador rechaza productos inactivos y versiones viejas', () => {
  const inactive = planOrderUpdate({
    order: order({ items: [intactDraftItem()] }),
    client,
    catalogProducts: [{ ...products[0], active: false }, products[1]],
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    draftEdit: true,
    invoiceType: 'A',
    paymentCondition: 'contado',
    version: 0,
  });

  assert.equal(inactive.ok, false);
  if (!inactive.ok) {
    assert.equal(inactive.status, 400);
    assert.equal(inactive.message, DRAFT_EDIT_INACTIVE_PRODUCT_ERROR);
  }

  const staleVersion = planOrderUpdate({
    order: order({ version: 3, items: [intactDraftItem()] }),
    client,
    catalogProducts: products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    draftEdit: true,
    invoiceType: 'A',
    paymentCondition: 'contado',
    version: 2,
  });

  assert.equal(staleVersion.ok, false);
  if (!staleVersion.ok) {
    assert.equal(staleVersion.status, 409);
    assert.equal(staleVersion.code, ORDER_VERSION_CONFLICT_CODE);
    assert.deepEqual(staleVersion.extras, { version: 3 });
  }
});

test('applyOrderUpdatePlan persiste los datos comerciales del borrador', () => {
  const result = planOrderUpdate({
    order: order({ items: [intactDraftItem()] }),
    client,
    catalogProducts: products,
    items: [{ productId: oid('1'), requestedQuantity: 1 }],
    draftEdit: true,
    invoiceType: 'B',
    paymentCondition: 'otro',
    paymentConditionDetail: '  cheque a 30 días  ',
    version: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const target: any = {
    status: 'borrador',
    items: [],
    comments: [],
    invoiceType: 'A',
    paymentCondition: 'contado',
    paymentConditionDetail: 'detalle anterior',
  };

  applyOrderUpdatePlan(target, result.value);

  assert.equal(target.status, 'borrador');
  assert.equal(target.invoiceType, 'B');
  assert.equal(target.paymentCondition, 'otro');
  assert.equal(target.paymentConditionDetail, 'cheque a 30 días');
  assert.equal(target.items.length, 1);
});

// ---------------------------------------------------------------------------
// Control post-factura
// ---------------------------------------------------------------------------

test('planPostControlUpdates valida versión, estado y existencia de las líneas', () => {
  const postOrder = {
    version: 2,
    status: 'facturacion' as const,
    items: [{ _id: oid('a') }, { _id: oid('b') }],
  };

  const ok = planPostControlUpdates({
    order: postOrder,
    version: 2,
    updates: [{ _id: oid('a'), postControl: 'ok' }],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.value.assignments, [{ itemId: oid('a'), postControl: 'ok' }]);
  }

  const stale = planPostControlUpdates({
    order: postOrder,
    version: 1,
    updates: [{ _id: oid('a'), postControl: 'ok' }],
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.status, 409);
    assert.equal(stale.code, ORDER_VERSION_CONFLICT_CODE);
    assert.deepEqual(stale.extras, { version: 2 });
  }

  const wrongStatus = planPostControlUpdates({
    order: { ...postOrder, status: 'entregado' },
    version: 2,
    updates: [{ _id: oid('a'), postControl: 'ok' }],
  });
  assert.equal(wrongStatus.ok, false);
  if (!wrongStatus.ok) assert.equal(wrongStatus.status, 409);

  const missingItem = planPostControlUpdates({
    order: postOrder,
    version: 2,
    updates: [{ _id: oid('f'), postControl: 'ok' }],
  });
  assert.equal(missingItem.ok, false);
  if (!missingItem.ok) {
    assert.equal(missingItem.status, 404);
    assert.match(missingItem.message, /no encontrado/i);
  }
});

// ---------------------------------------------------------------------------
// Notificaciones
// ---------------------------------------------------------------------------

test('los builders de notificación son puros y estables', () => {
  assert.deepEqual(
    buildDraftOrderNotification({
      createdBy: 'vendedor',
      clientName: 'Cliente Demo',
      finalTotal: 1234.5,
    }),
    {
      title: 'Nuevo Pedido (Borrador)',
      message: 'El vendedor vendedor creó un pedido para Cliente Demo por $1234.50',
      targetRole: 'deposit',
    },
  );

  assert.deepEqual(buildReadyForBillingNotification({ clientName: 'Cliente Demo' }), {
    title: 'Pedido Listo para Facturar',
    message: 'El pedido de Cliente Demo ha sido verificado en depósito y está listo para facturar.',
    targetRole: 'billing',
  });
});
