/**
 * Pruebas del panel operativo:
 *
 * - rango del día comercial en America/Argentina/Buenos_Aires;
 * - conteos por estado sobre pedidos no archivados y alcance por rol, con los
 *   estados ajenos al rol completados en 0 y sin consultarlos;
 * - aggregate de hoy ($match + $group) con conteo e importe propio del vendedor;
 * - filtro de "últimos pedidos" por rol y límite;
 * - uso de los índices existentes en los counts y en el aggregate.
 *
 * Usa MongoDB en memoria porque estas garantías dependen del motor real
 * (agregación, índices y orden). Ejecutar con: npm test.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { Order } from '../models/Order';
import {
  DASHBOARD_LATEST_LIMIT,
  buildLatestOrdersFilter,
  buildTodayStatsPipeline,
  getDashboardMetrics,
  type DashboardMetrics,
} from '../lib/dashboard';
import { getDayRange } from '../lib/dashboard-time';

const NOW = new Date('2026-10-23T15:00:00.000Z'); // 12:00 en Argentina
const DAY_START = new Date('2026-10-23T03:00:00.000Z');
const DAY_END = new Date('2026-10-24T03:00:00.000Z');

const SELLER_ID = new mongoose.Types.ObjectId();
const OTHER_ID = new mongoose.Types.ObjectId();
const CLIENT_ID = new mongoose.Types.ObjectId();

let mongo: MongoMemoryServer;

interface OrderSeed {
  status: string;
  finalTotal: number;
  createdAt: Date;
  archived?: boolean;
  createdById?: mongoose.Types.ObjectId | null;
  createdBy?: string;
  clientName?: string;
}

function orderDocument(seed: OrderSeed) {
  return {
    clientId: CLIENT_ID,
    clientName: seed.clientName ?? 'Cliente Dashboard',
    clientCode: 'DASH-1',
    status: seed.status,
    items: [],
    subtotal: seed.finalTotal,
    totalDiscount: 0,
    finalTotal: seed.finalTotal,
    createdBy: seed.createdBy ?? 'e2e-vendedor',
    ...(seed.createdById === null ? {} : { createdById: seed.createdById ?? SELLER_ID }),
    comments: [],
    archived: seed.archived ?? false,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
  };
}

async function insertOrders(seeds: OrderSeed[]): Promise<void> {
  await Order.collection.insertMany(seeds.map(orderDocument));
}

function assertCounts(metrics: DashboardMetrics, expected: Record<string, number>): void {
  assert.deepEqual(metrics.counts, expected);
}

before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { dbName: 'sgi-dashboard-test' } });
  await mongoose.connect(mongo.getUri('sgi-dashboard-test'));
  // dbConnect() reutiliza esta conexión sin abrir otra ni validar MONGODB_URI.
  (globalThis as { mongoose?: unknown }).mongoose = { conn: mongoose, promise: null };
  await Order.createIndexes();
});

beforeEach(async () => {
  await Order.deleteMany({});
});

after(async () => {
  await Order.deleteMany({});
  await mongoose.disconnect();
  await mongo.stop();
});

test('el día comercial se calcula en la zona de Argentina, no en UTC', () => {
  assert.deepEqual(getDayRange(NOW), { start: DAY_START, end: DAY_END });

  // Un pedido de las 23:30 locales del día anterior cae fuera del rango.
  const lateYesterday = new Date('2026-10-23T02:30:00.000Z');
  const range = getDayRange(NOW);
  assert.ok(lateYesterday < range.start);
  assert.equal(new Date('2026-10-23T03:00:00.000Z').getTime(), range.start.getTime());
});

test('cuenta estados no archivados y agrega pedidos e importe del día', async () => {
  await insertOrders([
    { status: 'borrador', finalTotal: 100, createdAt: DAY_START },
    { status: 'paralizado', finalTotal: 200, createdAt: new Date('2026-10-23T23:59:00.000Z') },
    {
      status: 'facturacion',
      finalTotal: 300,
      createdAt: new Date('2026-10-23T02:59:59.999Z'),
    },
    {
      status: 'control_post_factura',
      finalTotal: 400,
      createdAt: NOW,
      archived: true,
    },
    {
      status: 'control_post_factura',
      finalTotal: 450,
      createdAt: new Date('2026-10-22T15:00:00.000Z'),
      createdById: OTHER_ID,
    },
    { status: 'entregado', finalTotal: 500, createdAt: NOW, createdById: OTHER_ID },
    { status: 'borrador', finalTotal: 600, createdAt: NOW, createdById: OTHER_ID },
    {
      status: 'entregado',
      finalTotal: 700,
      createdAt: NOW,
      createdById: null,
      createdBy: 'e2e-vendedor',
    },
  ]);

  const metrics = await getDashboardMetrics(
    { userId: 'admin-id', username: 'admin', role: 'admin' },
    NOW,
  );

  assertCounts(metrics, {
    borrador: 2,
    paralizado: 1,
    facturacion: 1,
    control_post_factura: 1,
    entregado: 2,
  });
  assert.equal(metrics.todayOrders, 5);
  assert.equal(metrics.todayAmount, 2100);
  assert.equal(metrics.latestOrders.length, 7);
});

test('solo consulta countDocuments para los estados que gestiona el rol', async () => {
  await insertOrders([
    { status: 'borrador', finalTotal: 100, createdAt: NOW },
    { status: 'paralizado', finalTotal: 200, createdAt: NOW },
    { status: 'facturacion', finalTotal: 300, createdAt: NOW },
    { status: 'entregado', finalTotal: 400, createdAt: NOW },
  ]);

  type CountDocumentsFn = (filter?: Record<string, unknown>) => Promise<number>;
  const originalCountDocuments = Order.countDocuments.bind(Order) as unknown as CountDocumentsFn;
  const model = Order as unknown as { countDocuments: CountDocumentsFn };
  const queriedStatuses: string[] = [];

  model.countDocuments = (filter) => {
    if (typeof filter?.status === 'string') queriedStatuses.push(filter.status);
    return originalCountDocuments(filter);
  };

  try {
    const metrics = await getDashboardMetrics(
      { userId: 'deposit-id', username: 'controlador', role: 'controlador' },
      NOW,
    );

    assert.deepEqual(queriedStatuses.sort(), ['borrador', 'paralizado']);
    assertCounts(metrics, {
      borrador: 1,
      paralizado: 1,
      facturacion: 0,
      control_post_factura: 0,
      entregado: 0,
    });
  } finally {
    model.countDocuments = originalCountDocuments;
  }
});

test('el vendedor solo cuenta y lista sus pedidos, con el monto de su propio scope', async () => {
  await insertOrders([
    { status: 'borrador', finalTotal: 100, createdAt: DAY_START },
    { status: 'paralizado', finalTotal: 200, createdAt: NOW },
    { status: 'facturacion', finalTotal: 300, createdAt: NOW },
    {
      status: 'control_post_factura',
      finalTotal: 400,
      createdAt: NOW,
      archived: true,
    },
    { status: 'entregado', finalTotal: 500, createdAt: NOW, createdById: OTHER_ID },
    { status: 'borrador', finalTotal: 600, createdAt: NOW, createdById: OTHER_ID },
    {
      status: 'entregado',
      finalTotal: 700,
      createdAt: NOW,
      createdById: null,
      createdBy: 'e2e-vendedor',
    },
  ]);

  const metrics = await getDashboardMetrics(
    { userId: SELLER_ID.toString(), username: 'e2e-vendedor', role: 'vendedor' },
    NOW,
  );

  assertCounts(metrics, {
    borrador: 1,
    paralizado: 1,
    facturacion: 1,
    control_post_factura: 0,
    entregado: 1,
  });
  assert.equal(metrics.todayOrders, 4);
  assert.equal(
    metrics.todayAmount,
    1300,
    'el vendedor recibe el importe de sus propios pedidos (100 + 200 + 300 + 700)',
  );
  assert.equal(metrics.latestOrders.length, 4);
  assert.ok(metrics.latestOrders.every((order) => order.clientName === 'Cliente Dashboard'));
});

test('los últimos pedidos se acotan a las etapas del rol y al límite', async () => {
  const seeds: OrderSeed[] = [
    { status: 'borrador', finalTotal: 1, createdAt: new Date('2026-10-01T10:00:00Z') },
    { status: 'paralizado', finalTotal: 2, createdAt: new Date('2026-10-02T10:00:00Z') },
    { status: 'facturacion', finalTotal: 3, createdAt: new Date('2026-10-03T10:00:00Z') },
    {
      status: 'control_post_factura',
      finalTotal: 4,
      createdAt: new Date('2026-10-04T10:00:00Z'),
    },
    { status: 'entregado', finalTotal: 5, createdAt: new Date('2026-10-05T10:00:00Z') },
  ];

  for (let index = 0; index < 10; index += 1) {
    seeds.push({
      status: 'borrador',
      finalTotal: 100 + index,
      createdAt: new Date(`2026-10-10T${String(index).padStart(2, '0')}:00:00Z`),
    });
  }

  await insertOrders(seeds);

  const deposit = await getDashboardMetrics(
    { userId: 'deposit-id', username: 'controlador', role: 'controlador' },
    NOW,
  );
  assertCounts(deposit, {
    borrador: 11,
    paralizado: 1,
    facturacion: 0,
    control_post_factura: 0,
    entregado: 0,
  });
  assert.equal(deposit.latestOrders.length, DASHBOARD_LATEST_LIMIT);
  assert.ok(
    deposit.latestOrders.every(
      (order) => order.status === 'borrador' || order.status === 'paralizado',
    ),
    'depósito solo ve borradores y paralizados en el bloque',
  );
  assert.deepEqual(
    deposit.latestOrders.map((order) => order.finalTotal),
    [109, 108, 107, 106, 105, 104, 103, 102],
  );

  const billing = await getDashboardMetrics(
    { userId: 'billing-id', username: 'billing', role: 'billing' },
    NOW,
  );
  assertCounts(billing, {
    borrador: 0,
    paralizado: 0,
    facturacion: 1,
    control_post_factura: 1,
    entregado: 1,
  });
  assert.deepEqual(
    billing.latestOrders.map((order) => order.status),
    ['entregado', 'control_post_factura', 'facturacion'],
  );

  const filter = buildLatestOrdersFilter({
    userId: 'seller-id',
    username: 'e2e-vendedor',
    role: 'vendedor',
  });
  assert.ok(filter.$or, 'el vendedor conserva el filtro por creador');
});

test('el aggregate del día usa $match/$group y el índice de archived + createdAt', async () => {
  const pipeline = buildTodayStatsPipeline({ archived: false }, { start: DAY_START, end: DAY_END });

  assert.deepEqual(pipeline[0], {
    $match: { archived: false, createdAt: { $gte: DAY_START, $lt: DAY_END } },
  });
  assert.deepEqual(pipeline[1], {
    $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$finalTotal' } },
  });

  const explain = (await Order.aggregate(pipeline).explain('executionStats')) as {
    stages?: Array<{
      $cursor?: { executionStats?: { totalDocsExamined?: number }; queryPlanner?: unknown };
    }>;
    queryPlanner?: unknown;
    executionStats?: { totalDocsExamined?: number };
  };
  const serialized = JSON.stringify(explain);
  assert.match(
    serialized,
    /archived_1_createdAt_-1__id_-1/,
    'debe usar el índice de archived + fecha',
  );
  assert.match(serialized, /IXSCAN/);
});

test('los counts por estado usan el índice compuesto archived + status', async () => {
  const explain = (await Order.collection
    .find({ archived: false, status: 'borrador' })
    .explain('executionStats')) as {
    queryPlanner?: { winningPlan?: unknown };
  };

  const serialized = JSON.stringify(explain.queryPlanner?.winningPlan);
  assert.match(serialized, /archived_1_status_1_createdAt_-1__id_-1/);
  assert.match(serialized, /IXSCAN/);
});
