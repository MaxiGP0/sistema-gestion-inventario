/**
 * Lectura compartida de pedidos.
 *
 * GET /api/orders, GET /api/orders/[id] y los Server Components de las bandejas
 * y los detalles deben devolver exactamente los mismos DTO, proyecciones,
 * populate y permisos. Toda esa política vive acá para que la API y el primer
 * render server-side no se desincronicen.
 */

import dbConnect from '@/lib/mongodb';
import { Order } from '@/models/Order';
import { canReadOrder, type OrderAccessSession } from '@/lib/order-access';
import { buildOrderCursorFilter, decodeOrderCursor, encodeOrderCursor } from '@/lib/order-cursor';
import { buildOrderListQuery, type OrderListFilterInput } from '@/lib/order-query';
import { objectIdSchema } from '@/lib/validations';
import type { CursorPagination, OrderDTO, OrderSummaryDTO, PagePagination } from '@/lib/types';

/** Tamaño de la primera página que renderizan las bandejas server-side. */
export const DEFAULT_ORDER_PAGE_SIZE = 50;
/** Default histórico de GET /api/orders cuando el cliente no envía `limit`. */
export const DEFAULT_ORDER_API_PAGE_SIZE = 100;
export const MAX_ORDER_PAGE_SIZE = 500;

/**
 * Proyección liviana de las tarjetas: cliente, vendedor, totales, contexto
 * comercial y los snapshots de cada línea necesarios para adelantar productos,
 * detectar faltantes y repetir el pedido sin un segundo GET. `items.productId`
 * viaja como referencia escalar (sin populate): no trae marcas ni precios de
 * línea, eso queda exclusivamente en el detalle.
 */
export const ORDER_LIST_SELECT =
  'clientId clientName clientCode status finalTotal createdBy createdAt archived version invoiceType paymentCondition paymentConditionDetail items._id items.productId items.productName items.productCode items.requestedQuantity items.verifiedQuantity items.isPending items.pendingReason comments';

/**
 * La tarjeta sólo muestra el último comentario. `$slice: -1` evita enviar el
 * historial completo en cada página del listado.
 */
const ORDER_LIST_COMMENTS_SLICE = -1;

export const ORDER_LIST_CLIENT_POPULATE = {
  path: 'clientId',
  select: 'code name localidad province',
};

/** Populate completo del cliente en el detalle, incluidos sus descuentos. */
export const ORDER_DETAIL_CLIENT_POPULATE = {
  path: 'clientId',
  select: 'code name address localidad province generalDiscount brandDiscounts',
  populate: { path: 'brandDiscounts.brandId', select: 'name codePrefix' },
};

/** Populate del producto de cada línea con su marca. */
export const ORDER_DETAIL_ITEM_POPULATE = {
  path: 'items.productId',
  // `active` permite omitir y avisar las líneas dadas de baja al precargar el
  // pedido en el carrito (repetir) o editarlo mientras siga en borrador.
  select: 'code name price priceWithIva brandId imageUrl active',
  populate: { path: 'brandId', select: 'name codePrefix' },
};

export interface OrderListPageOptions {
  /** `cursor` es el modo de las bandejas; `page` conserva compatibilidad. */
  mode?: 'cursor' | 'page';
  page?: number;
}

export type OrderListPageResult =
  | {
      ok: true;
      mode: 'cursor';
      orders: OrderSummaryDTO[];
      pagination: CursorPagination;
      /** Epoch ms de la lectura; el cliente decide si revalidar. */
      fetchedAt: number;
    }
  | {
      ok: true;
      mode: 'page';
      orders: OrderSummaryDTO[];
      pagination: PagePagination;
      fetchedAt: number;
    }
  | { ok: false; status: number; error: string };

export type OrderReadResult =
  { ok: true; order: OrderDTO; fetchedAt: number } | { ok: false; status: number; error: string };

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_ORDER_PAGE_SIZE;

  return Math.min(MAX_ORDER_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function normalizePage(page: number | undefined): number {
  if (!page || !Number.isFinite(page)) return 1;

  return Math.max(1, Math.trunc(page));
}

/**
 * Convierte el documento lean al mismo JSON que devolvería la API.
 *
 * Los Server Components no pueden serializar ObjectId ni otras clases de
 * Mongoose hacia el cliente; además las fechas viajan como string en los DTO.
 * Un round-trip JSON reproduce exactamente el cuerpo de `NextResponse.json`.
 */
function toJsonDto<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Resuelve una página del listado con los mismos filtros y permisos que la API.
 *
 * En modo cursor no se ejecuta `countDocuments` para las páginas siguientes:
 * se pide un documento extra para saber si hay `nextCursor` y el total sólo
 * viaja en la primera página.
 */
export async function buildOrderListPage(
  session: OrderAccessSession,
  filters: OrderListFilterInput,
  cursor: string | null = null,
  limit = DEFAULT_ORDER_PAGE_SIZE,
  options: OrderListPageOptions = {},
): Promise<OrderListPageResult> {
  const mode = options.mode ?? 'cursor';
  const pageSize = normalizeLimit(limit);
  const fetchedAt = Date.now();

  const filterResult = buildOrderListQuery(session, filters);
  if (!filterResult.ok) {
    return { ok: false, status: 400, error: filterResult.error };
  }

  const query = filterResult.query;
  await dbConnect();

  if (mode === 'page') {
    const page = normalizePage(options.page);
    const skip = (page - 1) * pageSize;

    // El conteo y la página no dependen entre sí: se resuelven en paralelo.
    const [total, orders] = await Promise.all([
      Order.countDocuments(query),
      Order.find(query)
        .select(ORDER_LIST_SELECT)
        .slice('comments', ORDER_LIST_COMMENTS_SLICE)
        .populate(ORDER_LIST_CLIENT_POPULATE)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    return {
      ok: true,
      mode: 'page',
      orders: toJsonDto<OrderSummaryDTO[]>(orders),
      pagination: {
        total,
        page,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
      fetchedAt,
    };
  }

  if (cursor) {
    const decoded = decodeOrderCursor(cursor);
    if (!decoded) {
      return { ok: false, status: 400, error: 'Cursor de paginación inválido' };
    }
    query.$and = [...(query.$and ?? []), buildOrderCursorFilter(decoded)];
  }

  // La primera página cuenta el total para el "Mostrando X de Y"; las
  // siguientes sólo traen la página siguiente, sin count ni skip.
  const [total, orders] = await Promise.all([
    cursor ? Promise.resolve<number | undefined>(undefined) : Order.countDocuments(query),
    Order.find(query)
      .select(ORDER_LIST_SELECT)
      .slice('comments', ORDER_LIST_COMMENTS_SLICE)
      .populate(ORDER_LIST_CLIENT_POPULATE)
      .sort({ createdAt: -1, _id: -1 })
      .limit(pageSize + 1)
      .lean(),
  ]);

  // Se pide un documento extra para saber si hay página siguiente sin ejecutar
  // otro count: el cursor apunta al último pedido devuelto.
  const hasMore = orders.length > pageSize;
  const pageOrders = hasMore ? orders.slice(0, pageSize) : orders;
  const lastOrder = pageOrders[pageOrders.length - 1];
  const nextCursor = hasMore && lastOrder ? encodeOrderCursor(lastOrder) : null;

  return {
    ok: true,
    mode: 'cursor',
    orders: toJsonDto<OrderSummaryDTO[]>(pageOrders),
    pagination: {
      mode: 'cursor',
      limit: pageSize,
      hasMore,
      nextCursor,
      ...(typeof total === 'number' ? { total } : {}),
    },
    fetchedAt,
  };
}

/**
 * Lee el detalle de un pedido aplicando la política de lectura por rol.
 *
 * El vendedor sólo puede leer sus pedidos; admin/controlador/billing conservan
 * el alcance operativo. El id inválido se responde como 400 sin llegar a Mongo.
 */
export async function getOrderForSession(
  session: OrderAccessSession,
  id: string,
): Promise<OrderReadResult> {
  const idValidation = objectIdSchema.safeParse(id);
  if (!idValidation.success) {
    return { ok: false, status: 400, error: 'ID de pedido inválido' };
  }

  await dbConnect();

  const fetchedAt = Date.now();
  const order = await Order.findById(idValidation.data)
    .populate(ORDER_DETAIL_CLIENT_POPULATE)
    .populate(ORDER_DETAIL_ITEM_POPULATE)
    .lean();

  if (!order) {
    return { ok: false, status: 404, error: 'Pedido no encontrado' };
  }

  // El vendedor no puede leer el detalle de pedidos ajenos, aunque conozca el
  // id. Admin/controlador/billing mantienen su alcance operativo.
  if (!canReadOrder(session, order)) {
    return { ok: false, status: 403, error: 'No autorizado para esta operación' };
  }

  return { ok: true, order: toJsonDto<OrderDTO>(order), fetchedAt };
}
