/**
 * Pruebas de GET /api/orders/export:
 * - mismos permisos y filtros que GET /api/orders (incluido el alcance del
 *   vendedor y el clientId inválido);
 * - CSV UTF-8 con BOM, separador ";" y contenido de cabecera/líneas;
 * - XLSX generado con exceljs en streaming y legible por exceljs;
 * - tope de 10.000 filas y consumo por cursor, sin materializar el listado.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean Order.find/Order.countDocuments antes de importar el route handler.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';

import { Order } from '../models/Order';
import {
  ORDER_EXPORT_MAX_ROWS,
  buildOrderExportFilename,
  buildOrderExportUrl,
  escapeCsvValue,
  parseContentDispositionFilename,
} from '../lib/order-export';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

const OWNER_ID = '0000000000000000000000a1';
const OTHER_ID = '0000000000000000000000b2';
const SESSION_USERNAME = 'test-vendedor';

const clientId = oid();
const baseOrder: any = {
  _id: oid(),
  clientId: { _id: clientId, code: 'C1', name: 'Cliente Demo' },
  clientName: 'Cliente Demo',
  clientCode: 'C1',
  status: 'facturacion',
  subtotal: 200,
  totalDiscount: 20,
  finalTotal: 180,
  createdBy: 'vendedor1',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  invoiceType: 'A',
  paymentCondition: 'cuenta_corriente',
  paymentConditionDetail: '30 días',
  items: [
    {
      productCode: 'P1',
      productName: 'Producto Demo',
      brandName: 'Marca Demo',
      unitPrice: 100,
      requestedQuantity: 2,
      verifiedQuantity: 1,
      itemDiscount: 10,
      lineTotal: 90,
    },
  ],
};

interface Capture {
  query?: any;
  select?: string;
  populates: any[];
  sort?: any;
  limit?: number;
  lean?: boolean;
  cursorOptions?: any;
  cursorCalls: number;
  toArrayCalls: number;
  closeCalls: number;
}

let capture: Capture;
let cursorDocs: any[] = [];
let consumed = 0;
let beforeNext: Promise<void> | null = null;

const fakeOrderQuery = (query: any) => {
  capture = {
    query,
    populates: [],
    cursorCalls: 0,
    toArrayCalls: 0,
    closeCalls: 0,
  };

  const chain: any = {
    select(select: string) {
      capture.select = select;
      return chain;
    },
    populate(populate: any) {
      capture.populates.push(populate);
      return chain;
    },
    sort(sort: any) {
      capture.sort = sort;
      return chain;
    },
    limit(limit: number) {
      capture.limit = limit;
      return chain;
    },
    lean() {
      capture.lean = true;
      return chain;
    },
    cursor(options: any) {
      capture.cursorOptions = options;
      capture.cursorCalls += 1;

      return {
        async *[Symbol.asyncIterator]() {
          for (const doc of cursorDocs) {
            if (beforeNext) await beforeNext;
            consumed += 1;
            yield doc;
          }
        },
        async close() {
          capture.closeCalls += 1;
        },
      };
    },
    async toArray() {
      capture.toArrayCalls += 1;
      return cursorDocs;
    },
  };

  return chain;
};

let GET: (request: Request) => Promise<Response>;

const exportOrders = async (
  queryString = '?format=csv',
  role: 'admin' | 'vendedor' | 'billing' = 'admin',
  userId = OWNER_ID,
) => {
  const response = await GET(
    authRequest(`http://localhost/api/orders/export${queryString}`, {}, role, userId),
  );
  const text = await response.text();
  return { response, text };
};

const resetCursor = (docs: any[] = []) => {
  cursorDocs = docs;
  consumed = 0;
  beforeNext = null;
  capture = undefined as unknown as Capture;
};

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'find', (query: any) => fakeOrderQuery(query));
  mock.method(Order as any, 'countDocuments', async () => 0);

  GET = (await import('../app/api/orders/export/route')).GET;
});

after(() => mock.restoreAll());

test('sin sesión responde 401 y no consulta pedidos', async () => {
  resetCursor([baseOrder]);
  const response = await GET(new Request('http://localhost/api/orders/export?format=csv'));

  assert.equal(response.status, 401);
  assert.equal(capture, undefined, 'no debe construir la query sin sesión');
});

test('el vendedor exporta sólo sus pedidos y admin no recibe ese filtro', async () => {
  resetCursor([]);

  await exportOrders('?format=csv&status=facturacion', 'vendedor');
  assert.deepEqual(capture.query.$or, [
    { createdById: OWNER_ID },
    { createdById: null, createdBy: SESSION_USERNAME },
  ]);
  assert.equal(capture.query.status, 'facturacion');

  await exportOrders('?format=csv&status=facturacion', 'admin');
  assert.equal(capture.query.$or, undefined);
  assert.equal(capture.query.createdById, undefined);
  assert.equal(capture.query.status, 'facturacion');
});

test('aplica los mismos filtros que el listado (estado, archivado, fechas, búsqueda y cliente)', async () => {
  resetCursor([]);

  await exportOrders(
    `?format=csv&status=borrador,paralizado&archived=all&search=Cliente%20Demo` +
      `&startDate=2026-01-01&endDate=2026-01-31&clientId=${String(clientId)}`,
  );

  assert.deepEqual(capture.query.status, { $in: ['borrador', 'paralizado'] });
  assert.equal(capture.query.archived, undefined, 'archived=all no debe filtrar');
  assert.equal(capture.query.clientId, String(clientId));
  assert.equal(capture.query.$text, undefined);
  assert.deepEqual(capture.query.$and[0].$or[0], {
    searchTokens: { $all: [/^cliente/, /^demo/] },
  });
  assert.ok(capture.query.createdAt.$gte instanceof Date);
  assert.ok(capture.query.createdAt.$lte instanceof Date);
  assert.equal(capture.query.createdAt.$lte.getHours(), 23);
  assert.equal(capture.query.createdAt.$lte.getMinutes(), 59);
  assert.equal(capture.query.createdAt.$lte.getSeconds(), 59);
  assert.equal(capture.query.createdAt.$lte.getMilliseconds(), 999);
});

test('las fechas ISO con hora se respetan sin recortarlas al día del servidor', async () => {
  resetCursor([]);

  await exportOrders(
    '?format=csv&startDate=2026-10-25T03%3A00%3A00.000Z' + '&endDate=2026-10-26T02%3A59%3A59.999Z',
  );

  assert.equal(capture.query.createdAt.$gte.toISOString(), '2026-10-25T03:00:00.000Z');
  assert.equal(capture.query.createdAt.$lte.toISOString(), '2026-10-26T02:59:59.999Z');
});

test('archived por defecto excluye archivados y archived=true los incluye', async () => {
  resetCursor([]);

  await exportOrders('?format=csv');
  assert.equal(capture.query.archived, false);

  await exportOrders('?format=csv&archived=true');
  assert.equal(capture.query.archived, true);
});

test('clientId inválido responde 400 sin consultar la base', async () => {
  resetCursor([baseOrder]);

  const response = await GET(
    authRequest('http://localhost/api/orders/export?format=csv&clientId=no-es-un-id'),
  );
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.match(json.error, /clientId/i);
  assert.equal(capture, undefined);
});

test('un formato desconocido responde 400', async () => {
  resetCursor([baseOrder]);

  const response = await GET(authRequest('http://localhost/api/orders/export?format=pdf'));
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.match(json.error, /csv o xlsx/i);
  assert.equal(capture, undefined);
});

test('CSV usa BOM UTF-8, separador ";" y contiene totales y detalle de líneas', async () => {
  resetCursor([baseOrder]);

  const response = await GET(
    authRequest('http://localhost/api/orders/export?format=csv&status=facturacion'),
  );
  // response.text() aplica el decoder de UTF-8 y consume el BOM; se leen los
  // bytes para comprobar que el archivo realmente lo incluye.
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/csv/);
  assert.match(response.headers.get('content-disposition') || '', /pedidos-.*\.csv/);
  assert.ok(text.startsWith('\uFEFFID;Fecha;Cliente;Código de cliente;Vendedor;'));
  assert.match(text, /;Cliente Demo;C1;vendedor1;facturacion;200\.00;20\.00;180\.00;/);
  assert.match(text, /Cuenta corriente;Factura A;/);
  assert.match(text, /Pedida: 2 \| Verificada: 1 \| Precio: 100\.00/);
  assert.match(text, /Descuento: 10% \| Total: 90\.00/);
  assert.equal(text.split('\uFEFF').length, 2, 'el BOM debe aparecer una sola vez');
});

test('CSV escapa punto y coma, comillas y saltos de línea', () => {
  assert.equal(escapeCsvValue('Cliente; Sur'), '"Cliente; Sur"');
  assert.equal(escapeCsvValue('Cliente "Sur"'), '"Cliente ""Sur"""');
  assert.equal(escapeCsvValue('Linea 1\nLinea 2'), '"Linea 1\nLinea 2"');
});

test('XLSX se genera en streaming y se puede leer con exceljs', async () => {
  resetCursor([baseOrder]);

  const response = await GET(
    authRequest('http://localhost/api/orders/export?format=xlsx&status=facturacion'),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(response.headers.get('content-disposition') || '', /pedidos-.*\.xlsx/);

  const buffer = Buffer.from(await response.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.getWorksheet('Pedidos');

  assert.ok(worksheet);
  assert.equal(worksheet!.getRow(1).getCell(1).value, 'ID');
  assert.equal(worksheet!.getRow(1).getCell(12).value, 'Detalle de líneas');

  const row = worksheet!.getRow(2);
  assert.equal(row.getCell(1).value, String(baseOrder._id));
  assert.equal(row.getCell(3).value, 'Cliente Demo');
  assert.equal(row.getCell(4).value, 'C1');
  assert.equal(row.getCell(5).value, 'vendedor1');
  assert.equal(row.getCell(6).value, 'facturacion');
  assert.equal(row.getCell(7).value, 200);
  assert.equal(row.getCell(8).value, 20);
  assert.equal(row.getCell(9).value, 180);
  assert.match(String(row.getCell(12).value), /Pedida: 2 \| Verificada: 1/);
});

test('pide al cursor como máximo 10.000 filas y no usa toArray', async () => {
  resetCursor([]);

  await exportOrders('?format=csv');

  assert.equal(capture.limit, ORDER_EXPORT_MAX_ROWS);
  assert.equal(capture.limit, 10_000);
  assert.equal(capture.cursorCalls, 1);
  assert.equal(capture.toArrayCalls, 0);
  assert.equal(capture.lean, true);
  assert.deepEqual(capture.cursorOptions, { batchSize: 250 });
  assert.deepEqual(capture.sort, { createdAt: -1, _id: -1 });
});

test('CSV devuelve la respuesta antes de consumir el cursor (streaming real)', async () => {
  resetCursor([baseOrder, { ...baseOrder, _id: oid() }]);

  let release!: () => void;
  beforeNext = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Si el handler materializara el cursor, este timer lo desbloquearía para
  // que el test falle por `consumed > 0` en vez de quedarse colgado.
  const timer = setTimeout(() => release(), 150);

  const response = await GET(
    authRequest('http://localhost/api/orders/export?format=csv&status=facturacion'),
  );

  assert.equal(response.status, 200);
  assert.equal(consumed, 0, 'no debe leer todos los pedidos antes de responder');

  const text = await response.text();
  clearTimeout(timer);
  release();

  assert.equal(consumed, 2);
  assert.ok(text.includes('Cliente Demo'));
});

test('el nombre de archivo y la URL de exportación conservan los filtros', () => {
  assert.equal(
    buildOrderExportFilename('xlsx', new Date('2026-10-24T15:00:00.000Z')),
    'pedidos-2026-10-24.xlsx',
  );

  const url = buildOrderExportUrl('csv', {
    status: 'facturacion,entregado',
    archived: 'true',
    search: '  Cliente Demo  ',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    clientId: String(clientId),
  });

  assert.equal(
    url,
    `/api/orders/export?format=csv&status=facturacion%2Centregado&archived=true` +
      `&search=Cliente+Demo&startDate=2026-01-01&endDate=2026-01-31&clientId=${String(clientId)}`,
  );
});

test('parseContentDispositionFilename entiende filename y filename*', () => {
  assert.equal(
    parseContentDispositionFilename('attachment; filename="pedidos-2026-10-24.csv"'),
    'pedidos-2026-10-24.csv',
  );
  assert.equal(
    parseContentDispositionFilename(
      "attachment; filename=pedidos.csv; filename*=UTF-8''pedidos%20con%20espacios.csv",
    ),
    'pedidos con espacios.csv',
  );
  assert.equal(parseContentDispositionFilename(null), null);
});

test('un vendedor con pedidos ajenos nunca los recibe en la consulta', async () => {
  resetCursor([baseOrder]);

  await exportOrders('?format=csv&search=Cliente', 'vendedor', OTHER_ID);

  assert.deepEqual(capture.query.$or, [
    { createdById: OTHER_ID },
    { createdById: null, createdBy: SESSION_USERNAME },
  ]);
  assert.deepEqual(capture.query.$and[0].$or[0], {
    searchTokens: { $all: [/^cliente/] },
  });
});
