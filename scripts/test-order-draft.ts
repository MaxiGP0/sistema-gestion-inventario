/**
 * Pruebas del borrador de pedido (lib/order-draft.ts):
 * parseo tolerante de drafts viejos/corruptos, saneamiento de cantidades y
 * descuentos, y persistencia con un storage en memoria.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adjustOrderDraftProduct,
  applyClientToOrderDraft,
  clearOrderDraft,
  createOrderDraft,
  getOrderDraftStorageKey,
  loadOrderDraft,
  ORDER_DRAFT_EDIT_TTL_MS,
  ORDER_DRAFT_STORAGE_KEY,
  parseOrderDraft,
  saveOrderDraft,
  type OrderDraft,
  type OrderDraftStorage,
} from '../lib/order-draft';
import {
  attachOrderDraftLifecycleFlush,
  createOrderDraftAutosave,
} from '../lib/order-draft-autosave';
import {
  clearPendingOrderComment,
  getPendingOrderCommentStorageKey,
  loadPendingOrderComment,
  savePendingOrderComment,
} from '../lib/pending-order-comment';
import { getPickingAutosaveStorageKey, savePickingAutosave } from '../lib/picking-autosave';
import { clearUserOfflineData } from '../lib/pwa-client';

class MemoryStorage implements OrderDraftStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const client = {
  _id: 'cliente-1',
  code: 'CLI-1',
  name: 'Cliente Uno',
  address: 'Calle 1',
  localidad: 'Córdoba',
  province: 'Córdoba',
  generalDiscount: 5,
  brandDiscounts: [{ brandId: 'marca-1', discountPercentage: 10 }],
};

const preselectedClient = {
  _id: 'cliente-2',
  code: 'CLI-2',
  name: 'Cliente Dos',
  address: 'Calle 2',
  localidad: 'Córdoba',
  province: 'Córdoba',
  generalDiscount: 15,
  brandDiscounts: [
    { brandId: 'marca-2', discountPercentage: 20 },
    { brandId: 'marca-1', discountPercentage: 0 },
  ],
};

test('parseOrderDraft devuelve null para valores ausentes, JSON roto o primitivos', () => {
  assert.equal(parseOrderDraft(null), null);
  assert.equal(parseOrderDraft(''), null);
  assert.equal(parseOrderDraft('{roto'), null);
  assert.equal(parseOrderDraft('"texto"'), null);
  assert.equal(parseOrderDraft('[]'), null);
  assert.equal(parseOrderDraft('null'), null);
});

test('un objeto vacío restaura los valores por defecto sin romper', () => {
  assert.deepEqual(parseOrderDraft('{}'), {
    quantities: {},
    selectedClient: null,
    salesperson: '',
    comment: '',
    itemDiscounts: {},
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType: '',
    paymentCondition: '',
    paymentConditionDetail: '',
  });
});

test('parseOrderDraft sanea cantidades, descuentos, textos y cliente', () => {
  const parsed = parseOrderDraft(
    JSON.stringify({
      quantities: { a: 2, b: -1, c: '3', d: 1.8, e: 0 },
      selectedClient: {
        ...client,
        brandDiscounts: [
          { brandId: { _id: 'marca-2' }, discountPercentage: -10 },
          { brandId: 'marca-3', discountPercentage: 150 },
        ],
      },
      salesperson: 'Ana',
      comment: 42,
      itemDiscounts: { a: 5, b: 'x', c: -2, d: 120 },
      generalDiscount: 250,
      brandDiscounts: { m1: 12.5, m2: 'no', m3: -1 },
      invoiceType: 'A',
      paymentCondition: 'otro',
      paymentConditionDetail: '  cheque a 30 días  ',
    }),
  );

  assert.deepEqual(parsed, {
    quantities: { a: 2, d: 1, e: 0 },
    selectedClient: {
      _id: 'cliente-1',
      code: 'CLI-1',
      name: 'Cliente Uno',
      address: 'Calle 1',
      localidad: 'Córdoba',
      province: 'Córdoba',
      generalDiscount: 5,
      brandDiscounts: [
        { brandId: 'marca-2', discountPercentage: 0 },
        { brandId: 'marca-3', discountPercentage: 100 },
      ],
    },
    salesperson: 'Ana',
    comment: '',
    itemDiscounts: { a: 5, c: 0, d: 100 },
    generalDiscount: 100,
    brandDiscounts: { m1: 12.5, m3: 0 },
    invoiceType: 'A',
    paymentCondition: 'otro',
    paymentConditionDetail: 'cheque a 30 días',
  });
});

test('parseOrderDraft descarta condiciones inválidas y detalles huérfanos', () => {
  const cashWithDetail = parseOrderDraft(
    JSON.stringify({
      invoiceType: 'B',
      paymentCondition: 'contado',
      paymentConditionDetail: 'detalle que no corresponde',
    }),
  );
  assert.equal(cashWithDetail?.invoiceType, 'B');
  assert.equal(cashWithDetail?.paymentCondition, 'contado');
  assert.equal(cashWithDetail?.paymentConditionDetail, '');

  const invalidCondition = parseOrderDraft(
    JSON.stringify({
      paymentCondition: 'tarjeta',
      paymentConditionDetail: 'detalle',
    }),
  );
  assert.equal(invalidCondition?.paymentCondition, '');
  assert.equal(invalidCondition?.paymentConditionDetail, '');

  const invalidInvoiceType = parseOrderDraft(JSON.stringify({ invoiceType: 'C' }));
  assert.equal(invalidInvoiceType?.invoiceType, '');

  // Un draft histórico sin los campos se restaura sin condición ni factura.
  const legacy = parseOrderDraft(JSON.stringify({ salesperson: 'Ana' }));
  assert.equal(legacy?.paymentCondition, '');
  assert.equal(legacy?.paymentConditionDetail, '');
  assert.equal(legacy?.invoiceType, '');
});

test('un cliente inválido en el draft no impide restaurar el resto', () => {
  const parsed = parseOrderDraft(
    JSON.stringify({
      quantities: { a: 1 },
      selectedClient: { code: 'sin-id' },
      salesperson: 'Ana',
    }),
  );

  assert.equal(parsed?.selectedClient, null);
  assert.deepEqual(parsed?.quantities, { a: 1 });
  assert.equal(parsed?.salesperson, 'Ana');
});

test('saveOrderDraft, loadOrderDraft y clearOrderDraft usan la clave del usuario', () => {
  const storage = new MemoryStorage();
  const draft = createOrderDraft({
    quantities: { a: 2 },
    selectedClient: client,
    salesperson: 'Ana',
    comment: 'Entregar por la tarde',
    itemDiscounts: { a: 5 },
    generalDiscount: 5,
    brandDiscounts: { 'marca-1': 10 },
    invoiceType: 'B',
    paymentCondition: 'otro',
    paymentConditionDetail: 'cheque a 30 días',
  });
  const userId = 'usuario-a';

  assert.equal(saveOrderDraft(storage, draft, userId), true);
  assert.ok(storage.getItem(getOrderDraftStorageKey(userId)));
  assert.equal(ORDER_DRAFT_STORAGE_KEY, 'sgi_order_draft');
  assert.equal(getOrderDraftStorageKey(userId), 'sgi_order_draft:usuario-a');

  assert.deepEqual(loadOrderDraft(storage, userId), {
    quantities: { a: 2 },
    selectedClient: client,
    salesperson: 'Ana',
    comment: 'Entregar por la tarde',
    itemDiscounts: { a: 5 },
    generalDiscount: 5,
    brandDiscounts: { 'marca-1': 10 },
    invoiceType: 'B',
    paymentCondition: 'otro',
    paymentConditionDetail: 'cheque a 30 días',
  });

  assert.equal(clearOrderDraft(storage, userId), true);
  assert.equal(storage.getItem(getOrderDraftStorageKey(userId)), null);
  assert.equal(loadOrderDraft(storage, userId), null);
});

test('el borrador de un usuario no se restaura en otro ni desde la clave vieja', () => {
  const storage = new MemoryStorage();
  const draft = createOrderDraft({
    quantities: { a: 1 },
    selectedClient: client,
    salesperson: 'Ana',
    comment: 'Solo para Ana',
    itemDiscounts: {},
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType: '',
    paymentCondition: '',
    paymentConditionDetail: '',
  });

  assert.equal(saveOrderDraft(storage, draft, 'usuario-a'), true);
  assert.equal(loadOrderDraft(storage, 'usuario-b'), null);
  assert.equal(loadOrderDraft(storage, 'usuario-a')?.comment, 'Solo para Ana');

  // Un draft del esquema anterior (clave compartida) tampoco se filtra.
  storage.setItem(ORDER_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  assert.equal(loadOrderDraft(storage, 'usuario-b'), null);

  // Limpiar el borrador de un usuario no toca el de otro.
  assert.equal(saveOrderDraft(storage, draft, 'usuario-b'), true);
  assert.equal(clearOrderDraft(storage, 'usuario-a'), true);
  assert.equal(loadOrderDraft(storage, 'usuario-a'), null);
  assert.ok(loadOrderDraft(storage, 'usuario-b'));
});

test('adjustOrderDraftProduct crea el borrador y suma unidades desde el catálogo', () => {
  const created = adjustOrderDraftProduct(null, 'producto-1', 1, {
    salesperson: 'Ana',
  });

  assert.deepEqual(created, {
    quantities: { 'producto-1': 1 },
    selectedClient: null,
    salesperson: 'Ana',
    comment: '',
    itemDiscounts: {},
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType: '',
    paymentCondition: '',
    paymentConditionDetail: '',
  });

  const incremented = adjustOrderDraftProduct(created, 'producto-1', 2, {
    salesperson: 'Otro',
  });
  assert.equal(incremented.quantities['producto-1'], 3);
  assert.equal(incremented.salesperson, 'Ana', 'no pisa el vendedor ya guardado');
});

test('adjustOrderDraftProduct preserva el resto del borrador y limpia al llegar a 0', () => {
  const draft = createOrderDraft({
    quantities: { a: 2, b: 1 },
    selectedClient: client,
    salesperson: 'Ana',
    comment: 'Entregar por la tarde',
    itemDiscounts: { a: 5, b: 10 },
    generalDiscount: 5,
    brandDiscounts: { 'marca-1': 10 },
    invoiceType: 'B',
    paymentCondition: 'otro',
    paymentConditionDetail: 'cheque a 30 días',
  });

  const added = adjustOrderDraftProduct(draft, 'c', 4, { salesperson: 'Ana' });
  assert.deepEqual(added.quantities, { a: 2, b: 1, c: 4 });
  assert.equal(added.selectedClient, client);
  assert.equal(added.comment, 'Entregar por la tarde');
  assert.equal(added.invoiceType, 'B');
  assert.equal(added.paymentCondition, 'otro');
  assert.deepEqual(added.itemDiscounts, { a: 5, b: 10 });
  assert.equal(draft.quantities.c, undefined, 'no muta el borrador original');

  const removed = adjustOrderDraftProduct(added, 'a', -2, { salesperson: 'Ana' });
  assert.deepEqual(removed.quantities, { b: 1, c: 4 });
  assert.equal(removed.itemDiscounts.a, undefined, 'quita el descuento de la línea eliminada');
  assert.equal(removed.itemDiscounts.b, 10, 'conserva los descuentos de otras líneas');
  assert.equal(removed.quantities.b, 1);
});

test('adjustOrderDraftProduct nunca deja cantidades negativas ni valores inválidos', () => {
  const draft = createOrderDraft({
    quantities: { a: 1 },
    selectedClient: null,
    salesperson: '',
    comment: '',
    itemDiscounts: {},
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType: '',
    paymentCondition: '',
    paymentConditionDetail: '',
  });

  const belowZero = adjustOrderDraftProduct(draft, 'a', -5);
  assert.deepEqual(belowZero.quantities, {});
  assert.deepEqual(adjustOrderDraftProduct(draft, 'a', Number.NaN).quantities, { a: 1 });
  assert.deepEqual(adjustOrderDraftProduct(draft, 'b', 2.9).quantities, { a: 1, b: 2 });
  assert.equal(adjustOrderDraftProduct(draft, '', 1), draft, 'sin producto no cambia nada');
});

test('applyClientToOrderDraft conserva el carrito y aplica el cliente preseleccionado', () => {
  const saved = createOrderDraft({
    quantities: { 'producto-1': 2, 'producto-2': 3 },
    selectedClient: client,
    salesperson: 'Ana',
    comment: 'Entregar por la tarde',
    itemDiscounts: { 'producto-1': 7 },
    generalDiscount: 5,
    brandDiscounts: { 'marca-1': 10 },
    invoiceType: 'B',
    paymentCondition: 'otro',
    paymentConditionDetail: 'cheque a 30 días',
  });

  const merged = applyClientToOrderDraft(saved, preselectedClient);

  // El carrito y los datos comerciales del borrador sobreviven...
  assert.deepEqual(merged.quantities, { 'producto-1': 2, 'producto-2': 3 });
  assert.deepEqual(merged.itemDiscounts, { 'producto-1': 7 });
  assert.equal(merged.salesperson, 'Ana');
  assert.equal(merged.comment, 'Entregar por la tarde');
  assert.equal(merged.invoiceType, 'B');
  assert.equal(merged.paymentCondition, 'otro');
  assert.equal(merged.paymentConditionDetail, 'cheque a 30 días');

  // ...pero el cliente y sus descuentos base son los de `?clientId=`.
  assert.equal(merged.selectedClient, preselectedClient);
  assert.equal(merged.generalDiscount, 15);
  assert.deepEqual(merged.brandDiscounts, { 'marca-2': 20, 'marca-1': 0 });

  // No muta el borrador original.
  assert.equal(saved.selectedClient, client);
  assert.equal(saved.generalDiscount, 5);
  assert.deepEqual(saved.brandDiscounts, { 'marca-1': 10 });
});

test('applyClientToOrderDraft parte de un borrador vacío si no había uno guardado', () => {
  const merged = applyClientToOrderDraft(null, preselectedClient);

  assert.deepEqual(merged.quantities, {});
  assert.deepEqual(merged.itemDiscounts, {});
  assert.equal(merged.selectedClient, preselectedClient);
  assert.equal(merged.generalDiscount, 15);
  assert.deepEqual(merged.brandDiscounts, { 'marca-2': 20, 'marca-1': 0 });
});

class FakeEventTarget {
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? new Set<() => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

const emptyDraft = (overrides: Partial<OrderDraft> = {}): OrderDraft =>
  createOrderDraft({
    quantities: {},
    selectedClient: null,
    salesperson: 'Ana',
    comment: '',
    itemDiscounts: {},
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType: '',
    paymentCondition: '',
    paymentConditionDetail: '',
    ...overrides,
  });

test('pagehide guarda el último cambio sin esperar el debounce', () => {
  const storage = new MemoryStorage();
  const userId = 'usuario-autosave';
  const controller = createOrderDraftAutosave({ storage, userId, debounceMs: 400 });
  const baseline = emptyDraft();
  controller.setBaseline(baseline);

  controller.schedule(
    emptyDraft({
      quantities: { producto: 3 },
      comment: 'Último cambio antes de cerrar',
    }),
  );

  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  const detach = attachOrderDraftLifecycleFlush(() => controller.flush(), {
    windowTarget,
    documentTarget,
    isDocumentHidden: () => true,
  });

  windowTarget.emit('pagehide');

  const stored = loadOrderDraft(storage, userId);
  assert.deepEqual(stored?.quantities, { producto: 3 });
  assert.equal(stored?.comment, 'Último cambio antes de cerrar');

  detach();
});

test('visibilitychange con la pestaña oculta guarda ya; visible no fuerza el flush', () => {
  const storage = new MemoryStorage();
  const userId = 'usuario-visibility';
  const controller = createOrderDraftAutosave({ storage, userId, debounceMs: 400 });
  controller.setBaseline(emptyDraft());

  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  let hidden = false;
  const detach = attachOrderDraftLifecycleFlush(() => controller.flush(), {
    windowTarget,
    documentTarget,
    isDocumentHidden: () => hidden,
  });

  controller.schedule(emptyDraft({ quantities: { producto: 1 } }));
  documentTarget.emit('visibilitychange');
  assert.equal(loadOrderDraft(storage, userId), null, 'visible no debe escribir');

  hidden = true;
  controller.schedule(emptyDraft({ quantities: { producto: 2 } }));
  documentTarget.emit('visibilitychange');
  assert.deepEqual(loadOrderDraft(storage, userId)?.quantities, { producto: 2 });

  detach();
});

test('el autosave no escribe sin usuario, sin cambios o con enabled=false', () => {
  const storage = new MemoryStorage();

  const noUser = createOrderDraftAutosave({ storage, userId: null });
  noUser.setBaseline(emptyDraft());
  noUser.schedule(emptyDraft({ quantities: { producto: 1 } }));
  assert.equal(noUser.flush(), false);
  assert.equal(loadOrderDraft(storage, 'usuario-a'), null);

  const disabled = createOrderDraftAutosave({
    storage,
    userId: 'usuario-a',
    enabled: false,
  });
  disabled.setBaseline(emptyDraft());
  disabled.schedule(emptyDraft({ quantities: { producto: 1 } }));
  assert.equal(disabled.flush(), false);
  assert.equal(loadOrderDraft(storage, 'usuario-a'), null);

  const noChanges = createOrderDraftAutosave({ storage, userId: 'usuario-a' });
  noChanges.setBaseline(emptyDraft());
  assert.equal(noChanges.flush(), false);
  assert.equal(noChanges.isDirty(), false);
  assert.equal(loadOrderDraft(storage, 'usuario-a'), null);

  noChanges.schedule(emptyDraft({ quantities: { producto: 2 } }));
  assert.equal(noChanges.isDirty(), true);
  assert.equal(noChanges.flush(), true);
  assert.deepEqual(loadOrderDraft(storage, 'usuario-a')?.quantities, { producto: 2 });
  assert.equal(noChanges.flush(), false, 'flush repetido no duplica la escritura');
});

test('el debounce sigue guardando al vencer aunque no haya pagehide', async () => {
  const storage = new MemoryStorage();
  const userId = 'usuario-debounce';
  const controller = createOrderDraftAutosave({ storage, userId, debounceMs: 10 });
  controller.setBaseline(emptyDraft());

  controller.schedule(emptyDraft({ quantities: { producto: 7 } }));
  assert.equal(loadOrderDraft(storage, userId), null);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(loadOrderDraft(storage, userId)?.quantities, { producto: 7 });
});

test('el borrador de comentario de facturación sobrevive y se limpia al enviar', () => {
  const storage = new MemoryStorage();

  assert.equal(
    savePendingOrderComment(storage, {
      orderId: 'pedido-1',
      userId: 'usuario-1',
      text: '  Falta la factura del cliente  ',
      savedAt: 1234,
    }),
    true,
  );

  assert.deepEqual(loadPendingOrderComment(storage, 'usuario-1', 'pedido-1'), {
    orderId: 'pedido-1',
    userId: 'usuario-1',
    text: 'Falta la factura del cliente',
    savedAt: 1234,
  });
  assert.equal(loadPendingOrderComment(storage, 'usuario-2', 'pedido-1'), null);
  assert.equal(loadPendingOrderComment(storage, 'usuario-1', 'pedido-2'), null);

  assert.equal(clearPendingOrderComment(storage, 'usuario-1', 'pedido-1'), true);
  assert.equal(loadPendingOrderComment(storage, 'usuario-1', 'pedido-1'), null);
});

test('un storage inaccesible no rompe la carga ni el guardado', () => {
  const throwingStorage: OrderDraftStorage = {
    getItem() {
      throw new Error('bloqueado');
    },
    setItem() {
      throw new Error('cuota');
    },
    removeItem() {
      throw new Error('bloqueado');
    },
  };

  assert.equal(loadOrderDraft(throwingStorage, 'usuario-a'), null);
  assert.equal(
    saveOrderDraft(
      throwingStorage,
      {
        quantities: {},
        selectedClient: null,
        salesperson: '',
        comment: '',
        itemDiscounts: {},
        generalDiscount: 0,
        brandDiscounts: {},
        invoiceType: '',
        paymentCondition: '',
        paymentConditionDetail: '',
      },
      'usuario-a',
    ),
    false,
  );
  assert.equal(clearOrderDraft(throwingStorage, 'usuario-a'), false);
  assert.equal(loadOrderDraft(null, 'usuario-a'), null);
  assert.equal(loadOrderDraft(new MemoryStorage(), null), null);
  assert.equal(saveOrderDraft(undefined, {} as never, 'usuario-a'), false);
  assert.equal(clearOrderDraft(undefined, ''), false);
});

test('el borrador de edición usa clave aislada por pedido, valida versión y vence a las 24 h', () => {
  const storage = new MemoryStorage();
  const userId = 'usuario-a';
  const orderId = 'pedido-101';
  const otherOrderId = 'pedido-202';
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);

  assert.equal(
    getOrderDraftStorageKey(userId, orderId),
    'sgi_order_draft:usuario-a:edit:pedido-101',
  );
  assert.equal(getOrderDraftStorageKey(userId), 'sgi_order_draft:usuario-a');

  const createDraft = emptyDraft({
    quantities: { 'prod-alta': 2 },
    comment: 'Borrador de alta nueva',
  });
  const editDraft = emptyDraft({
    quantities: { 'prod-edicion': 5 },
    comment: 'Edición del pedido 101',
    invoiceType: 'A',
    paymentCondition: 'contado',
  });
  const secondEditDraft = emptyDraft({
    quantities: { 'prod-edicion-2': 9 },
    comment: 'Edición del pedido 202',
  });

  assert.equal(saveOrderDraft(storage, createDraft, userId), true);
  assert.equal(
    saveOrderDraft(storage, editDraft, userId, {
      orderId,
      version: 3,
      savedAt: now - 1_000,
    }),
    true,
  );
  assert.equal(
    saveOrderDraft(storage, secondEditDraft, userId, {
      orderId: otherOrderId,
      version: 1,
      savedAt: now - 1_000,
    }),
    true,
  );

  // El borrador de alta nueva sigue intacto.
  assert.deepEqual(loadOrderDraft(storage, userId)?.quantities, { 'prod-alta': 2 });
  assert.equal(loadOrderDraft(storage, userId)?.comment, 'Borrador de alta nueva');

  // El borrador de edición se recupera con la misma versión y dentro del TTL de 24 h.
  const loadedEdit = loadOrderDraft(storage, userId, {
    orderId,
    version: 3,
    now,
  });
  assert.deepEqual(loadedEdit?.quantities, { 'prod-edicion': 5 });
  assert.equal(loadedEdit?.comment, 'Edición del pedido 101');

  // Otra versión del pedido o un TTL vencido (> 24 h) no se restauran.
  assert.equal(
    loadOrderDraft(storage, userId, {
      orderId,
      version: 4,
      now,
    }),
    null,
  );
  assert.equal(
    loadOrderDraft(storage, userId, {
      orderId,
      version: 3,
      now: now - 1_000 + ORDER_DRAFT_EDIT_TTL_MS,
    }),
    null,
  );

  // Limpiar el borrador de edición de un pedido no toca el alta ni otros pedidos.
  assert.equal(clearOrderDraft(storage, userId, { orderId }), true);
  assert.equal(loadOrderDraft(storage, userId, { orderId, version: 3, now }), null);
  assert.deepEqual(loadOrderDraft(storage, userId)?.quantities, { 'prod-alta': 2 });
  assert.deepEqual(
    loadOrderDraft(storage, userId, { orderId: otherOrderId, version: 1, now })?.quantities,
    { 'prod-edicion-2': 9 },
  );
});

test('el autosave en modo edición hace flush sincrónico en pagehide sin pisar el alta', () => {
  const storage = new MemoryStorage();
  const userId = 'usuario-edit-flush';
  const orderId = 'pedido-flush-1';

  saveOrderDraft(storage, emptyDraft({ quantities: { 'prod-alta': 1 } }), userId);

  const editController = createOrderDraftAutosave({
    storage,
    userId,
    orderId,
    version: 2,
    debounceMs: 400,
  });
  editController.setBaseline(emptyDraft({ quantities: { 'prod-edit': 2 } }));
  editController.schedule(
    emptyDraft({
      quantities: { 'prod-edit': 6 },
      comment: 'Ajuste en calle antes de bloquear pantalla',
    }),
  );

  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  const detach = attachOrderDraftLifecycleFlush(() => editController.flush(), {
    windowTarget,
    documentTarget,
    isDocumentHidden: () => true,
  });

  windowTarget.emit('pagehide');

  assert.deepEqual(loadOrderDraft(storage, userId)?.quantities, { 'prod-alta': 1 });
  const restoredEdit = loadOrderDraft(storage, userId, { orderId, version: 2 });
  assert.deepEqual(restoredEdit?.quantities, { 'prod-edit': 6 });
  assert.equal(restoredEdit?.comment, 'Ajuste en calle antes de bloquear pantalla');

  editController.clear();
  assert.equal(loadOrderDraft(storage, userId, { orderId, version: 2 }), null);
  assert.deepEqual(loadOrderDraft(storage, userId)?.quantities, { 'prod-alta': 1 });

  detach();
});

test('clearUserOfflineData limpia sgi_order_draft, sgi_picking_autosave y sgi_pending_order_comment', async () => {
  const storage = new MemoryStorage();
  const userId = 'usuario-logout';
  const orderId = 'pedido-logout';

  saveOrderDraft(storage, emptyDraft({ quantities: { a: 1 } }), userId);
  saveOrderDraft(storage, emptyDraft({ quantities: { b: 2 } }), userId, {
    orderId,
    version: 1,
  });
  savePickingAutosave(storage, {
    orderId,
    userId,
    version: 1,
    savedAt: Date.now(),
    items: {
      'linea-1': { verifiedQty: 2, controlled: true, pendingReason: '' },
    },
  });
  savePendingOrderComment(storage, {
    orderId,
    userId,
    text: 'Comentario pendiente de facturación',
    savedAt: Date.now(),
  });
  storage.setItem('sgi_theme', 'dark');

  assert.ok(storage.getItem(getOrderDraftStorageKey(userId)));
  assert.ok(storage.getItem(getOrderDraftStorageKey(userId, orderId)));
  assert.ok(storage.getItem(getPickingAutosaveStorageKey(userId, orderId)));
  assert.ok(storage.getItem(getPendingOrderCommentStorageKey(userId, orderId)));

  await clearUserOfflineData({ userId, storage });

  assert.equal(storage.getItem(getOrderDraftStorageKey(userId)), null);
  assert.equal(storage.getItem(getOrderDraftStorageKey(userId, orderId)), null);
  assert.equal(storage.getItem(getPickingAutosaveStorageKey(userId, orderId)), null);
  assert.equal(storage.getItem(getPendingOrderCommentStorageKey(userId, orderId)), null);
  assert.equal(storage.getItem('sgi_theme'), 'dark');
});
