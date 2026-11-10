/**
 * Pruebas del formato de líneas de facturación:
 * - Las líneas sin cantidad controlada no se omiten y se marcan como
 *   "Sin controlar/faltante", tanto en el panel como en el texto copiado.
 * - Una línea controlada con 100% de descuento no es faltante aunque su
 *   `lineTotal` sea 0.
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
  isMissingLine,
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

test('una línea controlada con 100% de descuento no es faltante aunque su total sea 0', () => {
  const item = {
    ...baseItem,
    verifiedQuantity: 2,
    itemDiscount: 100,
    lineTotal: 0,
  };

  assert.equal(isMissingLine(item), false);
  assert.equal(billingPendingDetail(item), '');

  const line = formatBillingItemLine(item, 0);
  assert.doesNotMatch(line, new RegExp(MISSING_LINE_LABEL));
  assert.doesNotMatch(line, /Motivo pendiente/);
  assert.match(line, /Cant: 2/);
  assert.match(line, /Desc: 100%/);
  assert.match(line, /Total: \$0\.00/);
});

test('una línea sin cantidad controlada es faltante', () => {
  const item = { ...baseItem, verifiedQuantity: 0, lineTotal: 0 };

  assert.equal(isMissingLine(item), true);
  assert.equal(billingPendingDetail(item), 'No verificado en depósito');
});

test('una línea pendiente sin cantidad verificada es faltante y conserva su motivo', () => {
  const item = {
    ...baseItem,
    verifiedQuantity: 0,
    isPending: true,
    pendingReason: 'Sin stock en depósito',
    lineTotal: 0,
  };

  assert.equal(isMissingLine(item), true);
  assert.equal(billingPendingDetail(item), 'Sin stock en depósito');

  const line = formatBillingItemLine(item, 0);
  assert.match(line, new RegExp(`${MISSING_LINE_LABEL}: Sin stock en depósito`));
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
