/**
 * Pruebas del autocompletado comercial desde el último pedido del cliente
 * (lib/order-commercial.ts). No requieren navegador ni base de datos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveCommercialDefaultsFromLastOrder,
  type CommercialSelection,
} from '../lib/order-commercial';

const emptySelection: CommercialSelection = {
  invoiceType: '',
  paymentCondition: '',
  paymentConditionDetail: '',
};

test('completa factura y condición de pago desde el último pedido cuando están vacías', () => {
  const next = resolveCommercialDefaultsFromLastOrder({
    current: emptySelection,
    lastOrder: { invoiceType: 'B', paymentCondition: 'cuenta_corriente' },
  });

  assert.deepEqual(next, {
    invoiceType: 'B',
    paymentCondition: 'cuenta_corriente',
    paymentConditionDetail: '',
  });
});

test('no pisa una elección manual del vendedor', () => {
  const next = resolveCommercialDefaultsFromLastOrder({
    current: {
      invoiceType: 'A',
      paymentCondition: 'contado',
      paymentConditionDetail: '',
    },
    lastOrder: { invoiceType: 'B', paymentCondition: 'cuenta_corriente' },
  });

  assert.equal(next, null);
});

test('respeta campos tocados aunque el vendedor los haya dejado vacíos', () => {
  const next = resolveCommercialDefaultsFromLastOrder({
    current: emptySelection,
    lastOrder: { invoiceType: 'B', paymentCondition: 'cuenta_corriente' },
    invoiceTypeTouched: true,
    paymentConditionTouched: true,
  });

  assert.equal(next, null);
});

test('completa sólo el campo que sigue libre y no toca el elegido a mano', () => {
  const next = resolveCommercialDefaultsFromLastOrder({
    current: {
      invoiceType: 'A',
      paymentCondition: '',
      paymentConditionDetail: '',
    },
    lastOrder: { invoiceType: 'B', paymentCondition: 'contado' },
    invoiceTypeTouched: true,
  });

  assert.deepEqual(next, {
    invoiceType: 'A',
    paymentCondition: 'contado',
    paymentConditionDetail: '',
  });
});

test('ignora valores inválidos o ausentes del pedido anterior', () => {
  assert.equal(
    resolveCommercialDefaultsFromLastOrder({
      current: emptySelection,
      lastOrder: { invoiceType: 'C', paymentCondition: 'transferencia' },
    }),
    null,
  );
  assert.equal(
    resolveCommercialDefaultsFromLastOrder({
      current: emptySelection,
      lastOrder: null,
    }),
    null,
  );
  assert.equal(
    resolveCommercialDefaultsFromLastOrder({
      current: emptySelection,
      lastOrder: {},
    }),
    null,
  );
});

test('arrastra el detalle cuando la condición anterior era "Otro"', () => {
  const next = resolveCommercialDefaultsFromLastOrder({
    current: emptySelection,
    lastOrder: {
      invoiceType: 'A',
      paymentCondition: 'otro',
      paymentConditionDetail: '  cheque a 30 días  ',
    },
  });

  assert.deepEqual(next, {
    invoiceType: 'A',
    paymentCondition: 'otro',
    paymentConditionDetail: 'cheque a 30 días',
  });
});

test('no inventa detalle si el pedido anterior no lo informó', () => {
  const next = resolveCommercialDefaultsFromLastOrder({
    current: emptySelection,
    lastOrder: { invoiceType: 'A', paymentCondition: 'otro' },
  });

  assert.deepEqual(next, {
    invoiceType: 'A',
    paymentCondition: 'otro',
    paymentConditionDetail: '',
  });
});
