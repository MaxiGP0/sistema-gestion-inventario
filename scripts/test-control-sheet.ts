/**
 * Pruebas de la hoja de control de pedido:
 * - Agrupa todas las líneas por marca (incluidas pendientes y faltantes).
 * - Ordena marcas alfabéticamente y productos por código natural.
 * - Calcula los totales sobre cantidades solicitadas con el descuento
 *   congelado de cada línea.
 * - La ruta de impresión queda restringida a admin/controlador por el proxy.
 *
 * Funciones puras, sin base de datos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { canAccessPage } from '../lib/authz';
import { formatBrandDiscount } from '../lib/billing-discounts';
import {
  compareNaturalCodes,
  controlSheetLineStatus,
  groupOrderItemsByBrand,
  summarizeControlSheetTotals,
  verifiedQuantityOf,
} from '../lib/control-sheet';

const item = (overrides: Record<string, unknown> = {}) => ({
  _id: 'item-1',
  productCode: 'P-1',
  productName: 'Producto Uno',
  brandName: 'Marca A',
  productId: {
    _id: 'product-1',
    code: 'P-1',
    name: 'Producto Uno',
    brandId: { _id: 'brand-a', name: 'Marca A' },
  },
  unitPrice: 100,
  requestedQuantity: 1,
  verifiedQuantity: 0,
  itemDiscount: 0,
  isPending: true,
  ...overrides,
});

test('agrupa por marca, ordena marcas alfabéticamente y productos por código natural', () => {
  const groups = groupOrderItemsByBrand([
    item({ _id: 'z-1', brandName: 'Zeta', productCode: 'Z-1' }),
    item({ _id: 'a-10', brandName: 'Alfa', productCode: 'A-10' }),
    item({ _id: 'a-2', brandName: 'Alfa', productCode: 'A-2' }),
    item({ _id: 'a-1', brandName: 'Alfa', productCode: 'A-1' }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.brandName),
    ['Alfa', 'Zeta'],
  );
  assert.deepEqual(
    groups[0].items.map((line) => line.productCode),
    ['A-1', 'A-2', 'A-10'],
  );
  assert.equal(groups[0].lineCount, 3);
  assert.equal(compareNaturalCodes('P-2', 'P-10') < 0, true);
});

test('usa la marca poblada como fallback y agrupa las líneas sin marca', () => {
  const groups = groupOrderItemsByBrand([
    item({
      _id: 'poblada',
      brandName: undefined,
      productId: { code: 'X-1', name: 'Producto X', brandId: { name: 'Marca Poblada' } },
    }),
    item({ _id: 'sin-marca', brandName: '  ', productId: null }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.brandName),
    ['Marca Poblada', 'Sin marca'],
  );
});

test('incluye todas las líneas, incluso pendientes, faltantes y con cantidad 0', () => {
  const groups = groupOrderItemsByBrand([
    item({
      _id: 'pendiente',
      productCode: 'P-1',
      requestedQuantity: 3,
      verifiedQuantity: 0,
      isPending: true,
      pendingReason: 'Sin controlar en depósito',
    }),
    item({
      _id: 'eliminada',
      productCode: 'P-2',
      requestedQuantity: 3,
      verifiedQuantity: 0,
      isPending: true,
      pendingReason: 'Eliminado en depósito',
    }),
    item({
      _id: 'cantidad-cero',
      productCode: 'P-3',
      requestedQuantity: 0,
      verifiedQuantity: 0,
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 3);
  assert.deepEqual(
    groups[0].items.map((line) => line._id),
    ['pendiente', 'eliminada', 'cantidad-cero'],
  );
});

test('calcula los totales sobre cantidades solicitadas, no verificadas', () => {
  const totals = summarizeControlSheetTotals([
    item({ unitPrice: 100, requestedQuantity: 3, verifiedQuantity: 1, itemDiscount: 10 }),
    item({ unitPrice: 50, requestedQuantity: 2, verifiedQuantity: 0, itemDiscount: 0 }),
  ]);

  assert.equal(totals.lineCount, 2);
  assert.equal(totals.subtotal, 400);
  assert.equal(totals.totalDiscount, 30);
  assert.equal(totals.finalTotal, 370);
  assert.equal(totals.effectiveDiscountPercentage, 7.5);
});

test('en modo verificado totaliza sobre verifiedQuantity y refleja faltantes', () => {
  const items = [
    item({
      _id: 'parcial',
      unitPrice: 100,
      requestedQuantity: 3,
      verifiedQuantity: 1,
      isPending: false,
      pendingReason: 'Faltante: 1 de 3 controlados',
      itemDiscount: 10,
    }),
    item({
      _id: 'total',
      unitPrice: 50,
      requestedQuantity: 2,
      verifiedQuantity: 0,
      isPending: true,
      pendingReason: 'Sin stock en depósito',
      itemDiscount: 0,
    }),
    item({
      _id: 'completa',
      unitPrice: 20,
      requestedQuantity: 2,
      verifiedQuantity: 2,
      isPending: false,
      itemDiscount: 0,
    }),
  ];

  const [group] = groupOrderItemsByBrand(items, 'verified');
  const totals = summarizeControlSheetTotals(items, 'verified');

  // La línea sin stock sigue visible en el grupo, pero no suma importes.
  assert.equal(group.items.length, 3);
  assert.equal(group.subtotal, 140);
  assert.equal(group.discountAmount, 10);
  assert.equal(totals.lineCount, 2);
  assert.equal(totals.subtotal, 140);
  assert.equal(totals.totalDiscount, 10);
  assert.equal(totals.finalTotal, 130);

  assert.equal(verifiedQuantityOf(items[0]), 1);
  assert.equal(verifiedQuantityOf(items[1]), 0);
  assert.equal(controlSheetLineStatus(items[0]).label, 'Faltante: 1 de 3 controlados');
  assert.equal(controlSheetLineStatus(items[1]).isShort, true);
  assert.equal(controlSheetLineStatus(items[2]).label, 'Completo');
});

test('el modo verificado cae a la cantidad pedida en pedidos históricos', () => {
  const historical = item({
    requestedQuantity: 4,
    verifiedQuantity: undefined,
    isPending: undefined,
  });

  assert.equal(verifiedQuantityOf(historical), 4);
  assert.equal(controlSheetLineStatus(historical).label, 'Completo');
  assert.equal(summarizeControlSheetTotals([historical], 'verified').subtotal, 400);
});

test('cada marca expone el rango de descuentos congelados de sus líneas', () => {
  const [brandA] = groupOrderItemsByBrand([
    item({ _id: 'a-1', brandName: 'Marca A', unitPrice: 100, itemDiscount: 25 }),
    item({ _id: 'a-2', brandName: 'Marca A', unitPrice: 100, itemDiscount: 15 }),
    item({ _id: 'b-1', brandName: 'Marca B', unitPrice: 50, itemDiscount: 0 }),
  ]);

  assert.equal(brandA.lineCount, 2);
  assert.equal(brandA.minDiscountPercentage, 15);
  assert.equal(brandA.maxDiscountPercentage, 25);
  assert.equal(brandA.subtotal, 200);
  assert.equal(brandA.discountAmount, 40);
  assert.equal(formatBrandDiscount(brandA), '15% – 25%');
});

test('la ruta de impresión bajo /deposit queda restringida a admin y controlador', () => {
  const printPath = '/deposit/orders/64b000000000000000000000/print';

  assert.equal(canAccessPage(printPath, 'admin'), true);
  assert.equal(canAccessPage(printPath, 'controlador'), true);
  assert.equal(canAccessPage(printPath, 'vendedor'), false);
  assert.equal(canAccessPage(printPath, 'billing'), false);
});

test('cada rol accede a su propia ruta imprimible sin abrir la bandeja ajena', () => {
  const id = '64b000000000000000000000';

  assert.equal(canAccessPage(`/orders/${id}/print`, 'vendedor'), true);
  assert.equal(canAccessPage(`/billing/orders/${id}/print`, 'billing'), true);
  assert.equal(canAccessPage(`/orders/${id}/print`, 'billing'), false);
  assert.equal(canAccessPage(`/billing/orders/${id}/print`, 'vendedor'), false);
  // El admin conserva el acceso transversal del proxy.
  assert.equal(canAccessPage(`/orders/${id}/print`, 'admin'), true);
  assert.equal(canAccessPage(`/billing/orders/${id}/print`, 'admin'), true);
});

test('las hojas del vendedor y de facturación resuelven el pedido en el servidor', () => {
  const cases = [
    {
      file: '../app/orders/[id]/print/page.tsx',
      roles: "['admin', 'vendedor']",
      backHref: 'backHref={`/orders/${id}`}',
    },
    {
      file: '../app/billing/orders/[id]/print/page.tsx',
      roles: "['admin', 'billing']",
      backHref: 'backHref={`/billing/orders/${id}`}',
    },
  ];

  for (const entry of cases) {
    const source = readFileSync(new URL(entry.file, import.meta.url), 'utf8');

    assert.match(source, /requireRolePage/);
    assert.ok(source.includes(entry.roles), `${entry.file} debe exigir los roles ${entry.roles}`);
    assert.match(source, /getOrderForSession/);
    assert.match(source, /initialOrder=/);
    assert.ok(source.includes(entry.backHref), `${entry.file} debe volver a su detalle`);
  }
});

test('la hoja alterna entre solicitado y verificado y oculta los botones al imprimir', () => {
  const pageSource = readFileSync(
    new URL('../app/deposit/orders/[id]/print/page.tsx', import.meta.url),
    'utf8',
  );
  const clientSource = readFileSync(
    new URL('../components/orders/PrintOrderSheetClient.tsx', import.meta.url),
    'utf8',
  );
  const sheetSource = readFileSync(new URL('../lib/control-sheet.ts', import.meta.url), 'utf8');
  const source = `${pageSource}\n${clientSource}`;

  // Server-first: el pedido se resuelve antes de pintar y viaja como data inicial.
  assert.match(pageSource, /getOrderForSession/);
  assert.match(pageSource, /initialOrder=/);
  assert.match(pageSource, /defaultMode="requested"/);
  assert.doesNotMatch(clientSource, /api\.get|fetchOrder|Cargando pedido/);

  assert.match(source, /@page\s*{\s*size:\s*A4 portrait;\s*margin:\s*8mm;\s*}/);
  assert.match(source, /window\.print\(\)/);
  assert.match(source, /groupOrderItemsByBrand\(order\.items, mode\)/);
  assert.match(source, /summarizeControlSheetTotals\(order\.items, mode\)/);
  assert.match(source, /controlSheetLineStatus/);
  assert.match(source, /requestedQuantity/);
  assert.match(source, /Cant\. solicitada/);
  assert.match(source, /Cant\. verificada/);
  assert.match(source, /Cant\. alterna/);
  assert.match(source, /Estado \/ faltante/);
  assert.match(source, /Solicitado/);
  assert.match(source, /Verificado/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /no-print/);
  assert.doesNotMatch(source, /generalDiscount|brandDiscounts/);

  // El cálculo del modo verificado vive en el módulo puro y no en el render.
  assert.match(sheetSource, /verifiedQuantity/);
  assert.match(sheetSource, /pendingReason/);
  assert.match(sheetSource, /ControlSheetMode/);
  assert.match(sheetSource, /summarizeBillingDiscounts\(items, mode\)/);

  // La previsualización móvil se adapta al teléfono y conserva el A4 en print.
  assert.match(source, /@media screen and \(max-width: 767px\)/);
  assert.match(source, /env\(safe-area-inset-top\)/);
  assert.match(source, /overflow-x: hidden/);
  assert.match(source, /@media print \{[\s\S]*?\.cs-sheet \{[\s\S]*?width: auto;/);
  assert.match(source, /\.cs-sheet \{[\s\S]*?width: 210mm;/);
});

test('cada ruta imprimible elige el modo inicial según su etapa', () => {
  const deposit = readFileSync(
    new URL('../app/deposit/orders/[id]/print/page.tsx', import.meta.url),
    'utf8',
  );
  const billing = readFileSync(
    new URL('../app/billing/orders/[id]/print/page.tsx', import.meta.url),
    'utf8',
  );
  const vendor = readFileSync(
    new URL('../app/orders/[id]/print/page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(deposit, /defaultMode="requested"/);
  assert.match(billing, /defaultMode="verified"/);
  assert.match(
    vendor,
    /defaultMode=\{result\.ok && result\.order\.status === 'borrador' \? 'requested' : 'verified'\}/,
  );
});

test('el service worker no cachea la hoja para no saltar la validación del proxy', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

  assert.match(source, /const STATIC_CACHE = `sgi-static-\$\{BUILD_ID\}`;/);
  assert.match(source, /isRoleProtectedPrintSheet/);
  assert.match(source, /pathname\.endsWith\('\/print'\)/);
  assert.match(source, /if \(isRoleProtectedPrintSheet\(url\)\) return;/);
});
