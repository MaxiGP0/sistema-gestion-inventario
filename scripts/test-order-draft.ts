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
  ORDER_DRAFT_STORAGE_KEY,
  parseOrderDraft,
  saveOrderDraft,
  type OrderDraftStorage,
} from '../lib/order-draft';

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
