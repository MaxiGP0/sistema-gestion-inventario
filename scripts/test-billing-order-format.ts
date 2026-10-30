/**
 * Pruebas del formato de líneas de facturación:
 * - Las líneas con `lineTotal === 0` no se omiten y se marcan como
 *   "Sin controlar/faltante", tanto en el panel como en el texto copiado.
 * - El motivo guardado por depósito (`pendingReason`) aparece en la línea.
 *
 * Funciones puras, sin base de datos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  billingLineQuantity,
  billingPendingDetail,
  formatBillingItemLine,
  MISSING_LINE_LABEL,
} from '../lib/billing-order-format';

const baseItem = {
  productCode: 'P-1',
  productName: 'Producto Uno',
  brandName: 'Marca Uno',
  unitPrice: 100,
  requestedQuantity: 3,
  verifiedQuantity: 3,
  itemDiscount: 10,
  lineTotal: 270,
};

test('incluye y marca las líneas en 0 como sin controlar/faltante', () => {
  const line = formatBillingItemLine(
    {
      ...baseItem,
      verifiedQuantity: 0,
      lineTotal: 0,
      pendingReason: 'Eliminado en depósito',
    },
    0,
  );

  assert.match(line, new RegExp(MISSING_LINE_LABEL));
  assert.match(line, /Eliminado en depósito/);
  assert.match(line, /Total: \$0\.00/);
  assert.equal(line.startsWith('1. [P-1] Producto Uno'), true);
});

test('una línea en 0 sin motivo guardado usa un detalle por defecto', () => {
  const line = formatBillingItemLine({ ...baseItem, verifiedQuantity: 0, lineTotal: 0 }, 1);

  assert.match(line, new RegExp(`${MISSING_LINE_LABEL}: No verificado en depósito`));
  assert.equal(line.startsWith('2. '), true);
});

test('las líneas con total positivo no llevan la marca de faltante', () => {
  const line = formatBillingItemLine(baseItem, 0);

  assert.doesNotMatch(line, new RegExp(MISSING_LINE_LABEL));
  assert.doesNotMatch(line, /Motivo pendiente/);
  assert.match(line, /Total: \$270\.00/);
});

test('las líneas parciales muestran el motivo pendiente sin marca de faltante total', () => {
  const item = {
    ...baseItem,
    verifiedQuantity: 2,
    lineTotal: 180,
    pendingReason: 'Faltante: 2 de 3 controlados',
  };

  assert.equal(billingPendingDetail(item), 'Faltante: 2 de 3 controlados');
  assert.equal(billingLineQuantity(item), 2);

  const line = formatBillingItemLine(item, 0);
  assert.doesNotMatch(line, new RegExp(MISSING_LINE_LABEL));
  assert.match(line, /Motivo pendiente: Faltante: 2 de 3 controlados/);
});

test('sin cantidad verificada se muestra la cantidad pedida', () => {
  assert.equal(billingLineQuantity({ ...baseItem, verifiedQuantity: undefined, lineTotal: 0 }), 3);
});
