/**
 * Datos del panel operativo, resueltos en el servidor.
 *
 * El dashboard necesita un conteo por cada estado que gestiona el rol, más el
 * pulso del día. Los conteos usan `countDocuments` sobre el índice compuesto
 * `{ archived: 1, status: 1, createdAt: -1, _id: -1 }`: cada uno resuelve con
 * un COUNT_SCAN indexado (ver docs/dashboard-kpis.md). La medición con 30.000
 * pedidos mostró que agrupar todos los estados en un aggregate era más lento
 * (11,9 ms vs. 4,1 ms), así que se mantienen los counts en paralelo.
 *
 * El resumen de hoy sí usa un aggregate con `$match`/`$group`: cuenta y suma
 * los importes en una sola pasada, con el rango del día local argentino.
 *
 * El alcance por rol reutiliza la política de lectura de pedidos: el vendedor
 * solo ve sus propios pedidos, por lo que los importes agregados del panel
 * siempre corresponden al scope de la sesión.
 */

import mongoose, { type PipelineStage } from 'mongoose';
import { Order } from '../models/Order';
import dbConnect from './mongodb';
import { getDayRange, type DayRange } from './dashboard-time';
import { buildOrderReadFilter, type OrderAccessSession } from './order-access';
import { roundCurrency } from './money';
import { ORDER_STATUS_LABELS } from './order-status-labels';
import type { OrderStatus } from './order-statuses';
import type { UserRole } from './authz';

export { DASHBOARD_TIME_ZONE, getDayRange, type DayRange } from './dashboard-time';

/** Estados que se muestran como colas en el panel. */
export const DASHBOARD_STATUSES = [
  'borrador',
  'paralizado',
  'facturacion',
  'control_post_factura',
  'entregado',
] as const;

export type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];

export const DASHBOARD_STATUS_LABELS: Record<DashboardStatus, string> = ORDER_STATUS_LABELS;

/** Cantidad máxima de pedidos del bloque "Últimos pedidos". */
export const DASHBOARD_LATEST_LIMIT = 8;

/** Estados de los últimos pedidos que le interesan a cada rol operativo. */
export const DASHBOARD_LATEST_STATUSES: Partial<Record<UserRole, readonly DashboardStatus[]>> = {
  controlador: ['borrador', 'paralizado'],
  billing: ['facturacion', 'control_post_factura', 'entregado'],
};

/** Estados que cada rol gestiona en el panel; el resto se informa en 0. */
export const DASHBOARD_STATUSES_BY_ROLE: Record<UserRole, readonly DashboardStatus[]> = {
  admin: DASHBOARD_STATUSES,
  vendedor: DASHBOARD_STATUSES,
  controlador: ['borrador', 'paralizado'],
  billing: ['facturacion', 'control_post_factura', 'entregado'],
};

/** Estados cuyos conteos necesita consultar el panel para el rol indicado. */
export function dashboardStatusesForRole(role: UserRole): readonly DashboardStatus[] {
  return DASHBOARD_STATUSES_BY_ROLE[role] ?? DASHBOARD_STATUSES;
}

export interface DashboardOrder {
  id: string;
  clientName: string;
  clientCode: string;
  status: OrderStatus;
  finalTotal: number;
  createdBy: string;
  createdAt: string;
}

export interface DashboardMetrics {
  counts: Record<DashboardStatus, number>;
  todayOrders: number;
  /** Importe de hoy dentro del scope de la sesión; `null` si el rol no puede verlo. */
  todayAmount: number | null;
  latestOrders: DashboardOrder[];
  /** Fecha/hora de cálculo, útil para mostrar el día del panel. */
  generatedAt: Date;
}

interface LatestOrderLean {
  _id: unknown;
  clientName?: string;
  clientCode?: string;
  status: OrderStatus;
  finalTotal: number;
  createdBy: string;
  createdAt?: Date;
}

/**
 * ¿El panel puede mostrar importes a este rol? Todas las consultas del panel
 * aplican el scope de la sesión, así que incluso el vendedor ve únicamente los
 * importes agregados de sus propios pedidos.
 */
export function canViewDashboardAmounts(role: UserRole): boolean {
  return role === 'admin' || role === 'vendedor' || role === 'controlador' || role === 'billing';
}

/**
 * Filtro común de pedidos del panel: nunca archivados y, para vendedores,
 * limitado a sus propios pedidos (misma regla que GET /api/orders).
 */
export function buildDashboardScope(
  session: OrderAccessSession,
  statuses?: readonly DashboardStatus[],
): Record<string, unknown> {
  const scope: Record<string, unknown> = { archived: false };
  const readFilter = buildOrderReadFilter(session);

  if (readFilter) Object.assign(scope, readFilter);

  if (statuses && statuses.length > 0) {
    scope.status = statuses.length === 1 ? statuses[0] : { $in: [...statuses] };
  }

  return scope;
}

/**
 * `aggregate()` no aplica el casting de Mongoose: el `createdById` del filtro
 * del vendedor debe llegar como ObjectId o el `$match` compararía un string
 * contra un ObjectId y no encontraría nada. Los count/find sí lo castean, pero
 * se usa el mismo scope para las tres consultas.
 */
function buildAggregationScope(session: OrderAccessSession): Record<string, unknown> {
  const scope = buildDashboardScope(session);
  const or = scope.$or;

  if (!Array.isArray(or)) return scope;

  return {
    ...scope,
    $or: or.map((condition) => {
      if (typeof condition !== 'object' || condition === null) return condition;

      const entry = condition as Record<string, unknown>;
      if (entry.createdById === null || entry.createdById === undefined) return entry;
      if (entry.createdById instanceof mongoose.Types.ObjectId) return entry;
      if (!/^[a-f0-9]{24}$/i.test(String(entry.createdById))) return entry;

      return { ...entry, createdById: new mongoose.Types.ObjectId(String(entry.createdById)) };
    }),
  };
}

/** Pipeline del resumen del día; se exporta para probarlo con explain(). */
export function buildTodayStatsPipeline(
  scope: Record<string, unknown>,
  range: DayRange,
): PipelineStage[] {
  return [
    {
      $match: {
        ...scope,
        createdAt: { $gte: range.start, $lt: range.end },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        amount: { $sum: '$finalTotal' },
      },
    },
  ];
}

function latestStatusesForRole(role: UserRole): readonly DashboardStatus[] | undefined {
  if (role === 'controlador' || role === 'billing') {
    return DASHBOARD_LATEST_STATUSES[role];
  }

  return undefined;
}

/**
 * Calcula en paralelo los conteos por estado, el resumen del día y los
 * últimos pedidos visibles para la sesión.
 */
export async function getDashboardMetrics(
  session: OrderAccessSession,
  now: Date = new Date(),
): Promise<DashboardMetrics> {
  await dbConnect();

  const scope = buildDashboardScope(session);
  const statuses = dashboardStatusesForRole(session.role);
  const range = getDayRange(now);

  const [countEntries, todayStats, latestOrders] = await Promise.all([
    Promise.all(
      statuses.map(async (status) => {
        const count = await Order.countDocuments({ ...scope, status });
        return [status, count] as const;
      }),
    ),
    Order.aggregate<{ _id: null; count: number; amount: number }>(
      buildTodayStatsPipeline(buildAggregationScope(session), range),
    ),
    Order.find(buildLatestOrdersFilter(session))
      .select('clientName clientCode status finalTotal createdBy createdAt')
      .sort({ createdAt: -1, _id: -1 })
      .limit(DASHBOARD_LATEST_LIMIT)
      .lean<LatestOrderLean[]>(),
  ]);

  // Los estados que el rol no gestiona no se consultan: se completan en 0 para
  // conservar la forma del KPI sin gastar COUNT_SCAN innecesarios.
  const counts = Object.fromEntries(DASHBOARD_STATUSES.map((status) => [status, 0])) as Record<
    DashboardStatus,
    number
  >;
  for (const [status, count] of countEntries) counts[status] = count;

  const today = todayStats[0];
  const todayAmount = canViewDashboardAmounts(session.role)
    ? roundCurrency(today?.amount ?? 0)
    : null;

  return {
    counts,
    todayOrders: today?.count ?? 0,
    todayAmount,
    latestOrders: latestOrders.map((order) => ({
      id: String(order._id),
      clientName: order.clientName || 'Cliente desconocido',
      clientCode: order.clientCode || '',
      status: order.status,
      finalTotal: roundCurrency(order.finalTotal ?? 0),
      createdBy: order.createdBy || '—',
      createdAt: (order.createdAt ?? now).toISOString(),
    })),
    generatedAt: now,
  };
}

/** Scope para la consulta de últimos pedidos (exportado para tests). */
export function buildLatestOrdersFilter(session: OrderAccessSession): Record<string, unknown> {
  const latestStatuses = latestStatusesForRole(session.role);
  return latestStatuses
    ? buildDashboardScope(session, latestStatuses)
    : buildDashboardScope(session);
}
