/**
 * Pruebas del resumen de pedido para compartir por WhatsApp/texto plano:
 * - Encabezado, número de pedido, fecha, cliente y condición comercial.
 * - Líneas completas con cantidades pedida/verificada, descuento y precio.
 * - Totales del pedido y fallbacks de datos históricos.
 *
 * Funciones puras, sin base de datos ni navegador.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildOrderShareText,
  buildOrderShareTitle,
  formatOrderShareDate,
  orderShareMode,
  orderShareNumber,
} from '../lib/order-share';

const ORDER_ID = '64b000000000000000a1b2c3';

const order = {
  _id: ORDER_ID,
  createdAt: '2026-10-25T14:30:00.000Z',
  createdBy: 'e2e-vendedor',
  clientId: { name: 'Farmacia E2E', code: 'E2E-CLI-001' },
  paymentCondition: 'cuenta_corriente',
  invoiceType: 'A',
  subtotal: 2000,
  totalDiscount: 100,
  finalTotal: 1900,
  items: [
    {
      productCode: 'E2E-PROD-001',
      productName: 'Producto E2E Principal',
      brandName: 'E2E Laboratorio',
      unitPrice: 1000,
      requestedQuantity: 2,
      verifiedQuantity: 2,
      itemDiscount: 5,
    },
  ],
};

test('arma el resumen completo con encabezado, datos comerciales y total final', () => {
  const text = buildOrderShareText(order, { timeZone: 'UTC' });

  assert.equal(
    text,
    [
      'SISTEMA DE GESTIÓN DE INVENTARIO',
      'Resumen de pedido',
      '',
      'Pedido: #a1b2c3',
      'Fecha: 25/10/2026 14:30',
      'Cliente: Farmacia E2E (E2E-CLI-001)',
      'Vendedor: e2e-vendedor',
      'Condición de pago: Cuenta corriente',
      'Tipo de factura: Factura A',
      '',
      'Detalle de líneas:',
      '1. [E2E-PROD-001] Producto E2E Principal (E2E Laboratorio)',
      '   Pedida: 2 · Verificada: 2 | Desc.: 5% | Unit.: $ 1.000,00 | Subtotal: $ 1.900,00',
      '',
      'Subtotal: $ 2.000,00',
      'Descuentos: -$ 100,00',
      'TOTAL FINAL: $ 1.900,00',
    ].join('\n'),
  );
});

test('usa snapshots, fallbacks del producto poblado y cantidades sin verificar', () => {
  const text = buildOrderShareText(
    {
      _id: ORDER_ID,
      createdAt: '2026-10-25T14:30:00.000Z',
      clientName: 'Cliente snapshot',
      clientCode: 'CLI-9',
      paymentCondition: 'otro',
      paymentConditionDetail: 'Cuenta a 30 días',
      invoiceType: 'B',
      items: [
        {
          productCode: '  ',
          productName: null,
          brandName: '',
          productId: {
            code: 'P-2',
            name: 'Producto poblado',
            brandId: { name: 'Marca poblada' },
          },
          unitPrice: 500.5,
          requestedQuantity: 3,
          verifiedQuantity: 0,
          itemDiscount: 7.5,
        },
        {
          productId: null,
          unitPrice: 10,
          requestedQuantity: 0,
          verifiedQuantity: 0,
        },
      ],
    },
    { timeZone: 'UTC' },
  );

  assert.match(text, /Cliente: Cliente snapshot \(CLI-9\)/);
  assert.match(text, /Vendedor: —/);
  assert.match(text, /Condición de pago: Otro — Cuenta a 30 días/);
  assert.match(text, /Tipo de factura: Factura B/);
  assert.match(text, /1\. \[P-2\] Producto poblado \(Marca poblada\)/);
  assert.match(
    text,
    /Pedida: 3 · Verificada: 0 · Faltante \| Desc\.: 7,5% \| Unit\.: \$ 500,50 \| Subtotal: \$ 0,00/,
  );
  // Las líneas con cantidad 0 no se filtran: también son parte del pedido.
  assert.match(text, /2\. Producto sin nombre \(Sin marca\)/);
  assert.match(text, /Pedida: 0 · Verificada: 0 \| Desc\.: 0%/);
});

test('en borrador sin control muestra cantidad pedida y subtotal sin "Verificada: 0"', () => {
  const draft = {
    _id: ORDER_ID,
    status: 'borrador',
    createdAt: '2026-10-25T14:30:00.000Z',
    clientName: 'Cliente borrador',
    items: [
      {
        productCode: 'P-10',
        productName: 'Producto borrador',
        brandName: 'Marca B',
        unitPrice: 100,
        requestedQuantity: 3,
        verifiedQuantity: 0,
        isPending: false,
        itemDiscount: 10,
        lineTotal: 270,
      },
    ],
  };

  assert.equal(orderShareMode(draft), 'requested');

  const text = buildOrderShareText(draft, { timeZone: 'UTC' });
  assert.match(text, /1\. \[P-10\] Producto borrador \(Marca B\)/);
  assert.match(text, /Cant\.: 3 \| Desc\.: 10% \| Unit\.: \$ 100,00 \| Subtotal: \$ 270,00/);
  assert.doesNotMatch(text, /Verificada/);
});

test('si el borrador ya tiene líneas controladas usa el detalle verificado', () => {
  const draftWithControl = {
    _id: ORDER_ID,
    status: 'borrador',
    items: [
      {
        productCode: 'P-11',
        unitPrice: 100,
        requestedQuantity: 3,
        verifiedQuantity: 2,
        itemDiscount: 0,
        lineTotal: 200,
      },
    ],
  };

  assert.equal(orderShareMode(draftWithControl), 'verified');
  const text = buildOrderShareText(draftWithControl, { timeZone: 'UTC' });
  assert.match(text, /Pedida: 3 · Verificada: 2 · Faltante/);
  assert.doesNotMatch(text, /Cant\.: 3/);
});

test('en pedido verificado informa faltante total, parcial y líneas completas', () => {
  const text = buildOrderShareText(
    {
      _id: ORDER_ID,
      status: 'facturacion',
      createdAt: '2026-10-25T14:30:00.000Z',
      clientName: 'Cliente controlado',
      subtotal: 130,
      totalDiscount: 10,
      finalTotal: 120,
      items: [
        {
          productCode: 'P-1',
          productName: 'Faltante parcial',
          brandName: 'Marca A',
          unitPrice: 100,
          requestedQuantity: 3,
          verifiedQuantity: 1,
          isPending: false,
          pendingReason: 'Faltante: 1 de 3 controlados',
          itemDiscount: 10,
          lineTotal: 90,
        },
        {
          productCode: 'P-2',
          productName: 'Faltante total',
          brandName: 'Marca A',
          unitPrice: 50,
          requestedQuantity: 2,
          verifiedQuantity: 0,
          isPending: true,
          pendingReason: 'Sin stock en depósito',
          itemDiscount: 0,
          lineTotal: 0,
        },
        {
          productCode: 'P-3',
          productName: 'Línea completa',
          brandName: 'Marca A',
          unitPrice: 20,
          requestedQuantity: 2,
          verifiedQuantity: 2,
          isPending: false,
          itemDiscount: 0,
          lineTotal: 40,
        },
      ],
    },
    { timeZone: 'UTC' },
  );

  assert.match(
    text,
    /Pedida: 3 · Verificada: 1 · Faltante: 1 de 3 controlados \| Desc\.: 10% \| Unit\.: \$ 100,00 \| Subtotal: \$ 90,00/,
  );
  assert.match(
    text,
    /Pedida: 2 · Verificada: 0 · Sin stock en depósito \| Desc\.: 0% \| Unit\.: \$ 50,00 \| Subtotal: \$ 0,00/,
  );
  assert.match(
    text,
    /Pedida: 2 · Verificada: 2 \| Desc\.: 0% \| Unit\.: \$ 20,00 \| Subtotal: \$ 40,00/,
  );
  assert.match(text, /TOTAL FINAL: \$ 120,00/);
});

test('tolera pedidos históricos sin cliente, fecha, comercial ni líneas', () => {
  const text = buildOrderShareText({ _id: 'abc' }, { timeZone: 'UTC' });

  assert.match(text, /Pedido: #abc/);
  assert.match(text, /Fecha: —/);
  assert.match(text, /Cliente: Cliente sin informar/);
  assert.match(text, /Vendedor: —/);
  assert.match(text, /Condición de pago: No informado/);
  assert.match(text, /Tipo de factura: No informado/);
  assert.match(text, /Sin líneas cargadas\./);
  assert.match(text, /Subtotal: \$ 0,00/);
  assert.match(text, /Descuentos: -\$ 0,00/);
  assert.match(text, /TOTAL FINAL: \$ 0,00/);
});

test('formatea la fecha en la zona del negocio y devuelve un guion si es inválida', () => {
  assert.equal(formatOrderShareDate('2026-10-25T14:30:00.000Z', 'UTC'), '25/10/2026 14:30');
  assert.equal(
    formatOrderShareDate('2026-10-25T23:30:00.000Z', 'America/Argentina/Buenos_Aires'),
    '25/10/2026 20:30',
  );
  assert.equal(formatOrderShareDate('no-es-una-fecha', 'UTC'), '—');
  assert.equal(formatOrderShareDate(null), '—');
});

test('el número y el título usan el mismo identificador corto de la interfaz', () => {
  assert.equal(orderShareNumber(order), 'a1b2c3');
  assert.equal(orderShareNumber({ _id: '' }), '—');
  assert.equal(buildOrderShareTitle(order), 'Sistema de Gestión de Inventario — Pedido #a1b2c3');
});
