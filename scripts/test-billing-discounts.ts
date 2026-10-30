/**
 * Pruebas del resumen de descuentos de facturación (lib/billing-discounts.ts):
 * - Usa el porcentaje congelado de cada línea (`itemDiscount`) y nunca la
 *   configuración actual del cliente.
 * - Agrupa por marca el descuento realmente aplicado, incluidos los ajustes
 *   manuales que hacen que una misma marca tenga porcentajes distintos.
 * - Excluye las líneas sin controlar (cantidad 0) de los importes.
 *
 * Funciones puras, sin base de datos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  formatBrandDiscount,
  formatDiscountRange,
  summarizeBillingDiscounts,
} from '../lib/billing-discounts';

const line = (overrides: Record<string, unknown> = {}) => ({
  brandName: 'Marca A',
  unitPrice: 100,
  requestedQuantity: 1,
  verifiedQuantity: 1,
  itemDiscount: 0,
  ...overrides,
});

test('usa el itemDiscount congelado e ignora la configuración actual del cliente', () => {
  // Propiedades extra a propósito: la función sólo debe mirar la línea.
  const items = [
    line({
      brandName: 'Marca A',
      verifiedQuantity: 2,
      itemDiscount: 25,
      generalDiscount: 99,
      brandDiscounts: [{ brandId: 'x', discountPercentage: 99 }],
    }),
    line({
      brandName: 'Marca B',
      unitPrice: 50,
      verifiedQuantity: 4,
      itemDiscount: 10,
      generalDiscount: 99,
      brandDiscounts: [{ brandId: 'y', discountPercentage: 99 }],
    }),
  ] as any;

  const summary = summarizeBillingDiscounts(items);

  assert.equal(summary.subtotal, 400);
  assert.equal(summary.totalDiscount, 70);
  assert.equal(summary.effectiveDiscountPercentage, 17.5);
  assert.equal(summary.minLineDiscountPercentage, 10);
  assert.equal(summary.maxLineDiscountPercentage, 25);
  assert.deepEqual(
    summary.brands.map((brand) => [
      brand.brandName,
      brand.minDiscountPercentage,
      brand.maxDiscountPercentage,
    ]),
    [
      ['Marca A', 25, 25],
      ['Marca B', 10, 10],
    ],
  );
});

test('agrupa por marca y conserva el rango cuando hay ajustes manuales distintos', () => {
  const summary = summarizeBillingDiscounts([
    line({ brandName: 'Marca A', itemDiscount: 25, unitPrice: 100 }),
    line({ brandName: 'Marca A', itemDiscount: 15, unitPrice: 100 }),
    line({ brandName: 'Marca B', itemDiscount: 0, unitPrice: 50, verifiedQuantity: 2 }),
  ]);

  assert.equal(summary.subtotal, 300);
  assert.equal(summary.totalDiscount, 40);
  assert.equal(summary.brands.length, 2);

  const [brandA, brandB] = summary.brands;
  assert.equal(brandA.brandName, 'Marca A');
  assert.equal(brandA.lineCount, 2);
  assert.equal(brandA.minDiscountPercentage, 15);
  assert.equal(brandA.maxDiscountPercentage, 25);
  assert.equal(brandA.discountPercentage, 20); // ponderado: 40 / 200
  assert.equal(brandA.discountAmount, 40);
  assert.equal(formatBrandDiscount(brandA), '15% – 25%');

  assert.equal(brandB.brandName, 'Marca B');
  assert.equal(formatBrandDiscount(brandB), '0%');
});

test('las líneas sin controlar (cantidad verificada 0) no aportan descuento ni marca', () => {
  const summary = summarizeBillingDiscounts([
    line({ brandName: 'Marca A', verifiedQuantity: 0, itemDiscount: 80 }),
    line({ brandName: 'Marca B', verifiedQuantity: 1, itemDiscount: 10 }),
  ]);

  assert.equal(summary.lineCount, 1);
  assert.equal(summary.subtotal, 100);
  assert.equal(summary.totalDiscount, 10);
  assert.deepEqual(
    summary.brands.map((brand) => brand.brandName),
    ['Marca B'],
  );
});

test('sin cantidad verificada usa la cantidad pedida y redondea como los totales del pedido', () => {
  const summary = summarizeBillingDiscounts([
    line({
      brandName: 'Marca A',
      unitPrice: 10.9,
      requestedQuantity: 3,
      verifiedQuantity: undefined,
      itemDiscount: 15,
    }),
  ]);

  assert.equal(summary.lineCount, 1);
  assert.equal(summary.subtotal, 32.7);
  assert.equal(summary.totalDiscount, 4.91);
  assert.equal(summary.effectiveDiscountPercentage.toFixed(2), '15.02');
});

test('quantityMode distingue verificado (facturación) de solicitado (hoja de control)', () => {
  const items = [
    line({
      brandName: 'Marca A',
      unitPrice: 100,
      requestedQuantity: 4,
      verifiedQuantity: 1,
      itemDiscount: 10,
    }),
    line({
      brandName: 'Marca B',
      unitPrice: 50,
      requestedQuantity: 2,
      verifiedQuantity: 0,
      itemDiscount: 0,
    }),
  ];

  // Por defecto se mantiene el criterio de facturación: solo lo controlado.
  const verified = summarizeBillingDiscounts(items);
  assert.equal(verified.lineCount, 1);
  assert.equal(verified.subtotal, 100);
  assert.equal(verified.totalDiscount, 10);
  assert.deepEqual(
    verified.brands.map((brand) => brand.brandName),
    ['Marca A'],
  );
  assert.deepEqual(summarizeBillingDiscounts(items, 'verified'), verified);

  // La hoja de control totaliza sobre lo pedido e incluye las líneas en 0.
  const requested = summarizeBillingDiscounts(items, 'requested');
  assert.equal(requested.lineCount, 2);
  assert.equal(requested.subtotal, 500);
  assert.equal(requested.totalDiscount, 40);
  assert.equal(requested.effectiveDiscountPercentage, 8);
  assert.deepEqual(
    requested.brands.map((brand) => [brand.brandName, brand.subtotal, brand.discountAmount]),
    [
      ['Marca A', 400, 40],
      ['Marca B', 100, 0],
    ],
  );
});

test('usa la marca poblada como fallback y agrupa las líneas sin marca', () => {
  const summary = summarizeBillingDiscounts([
    line({
      brandName: undefined,
      productId: { brandId: { _id: 'brand-1', name: 'Marca Poblada' } },
      itemDiscount: 5,
    }),
    line({ brandName: undefined, itemDiscount: 0 }),
  ]);

  assert.deepEqual(
    summary.brands.map((brand) => [brand.brandName, brand.brandId]),
    [
      ['Marca Poblada', 'brand-1'],
      ['Sin marca', undefined],
    ],
  );
});

test('formatea el rango general y el caso sin líneas facturables', () => {
  const mixed = summarizeBillingDiscounts([
    line({ itemDiscount: 25 }),
    line({ itemDiscount: 7.5 }),
  ]);
  assert.equal(formatDiscountRange(mixed), '7,5% – 25%');

  const uniform = summarizeBillingDiscounts([line({ itemDiscount: 10 })]);
  assert.equal(formatDiscountRange(uniform), '10%');

  assert.equal(formatDiscountRange(summarizeBillingDiscounts([])), '—');
});

test('el panel de facturación no lee generalDiscount ni brandDiscounts del cliente', () => {
  const source = readFileSync(
    new URL('../app/billing/orders/[id]/BillingOrderClient.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /generalDiscount|brandDiscounts/);
  assert.match(source, /summarizeBillingDiscounts/);
});
