import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole, requireSession } from '@/lib/auth';
import { resolveUserRole } from '@/lib/authz';
import { Order } from '@/models/Order';
import { Client } from '@/models/Client';
import { Product } from '@/models/Product';
import { createOrderSchema } from '@/lib/validations';
import { publishOrderNotification } from '@/lib/order-side-effects';
import { runAfterResponse } from '@/lib/after-response';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { findOrderByClientRequestId, isDuplicateKeyError } from '@/lib/order-idempotency';
import {
  buildOrderListPage,
  DEFAULT_ORDER_API_PAGE_SIZE,
  MAX_ORDER_PAGE_SIZE,
} from '@/lib/services/order-read';
import {
  collectRequestedProductIds,
  createOrderDraft,
  orderErrorBody,
} from '@/lib/services/orders';
import type {
  OrderCursorListResponse,
  OrderDTO,
  OrderListResponse,
  OrderMutationResponse,
} from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = requireSession(request);
    if ('response' in auth) return auth.response;

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const archivedParam = searchParams.get('archived'); // 'true', 'false', 'all'
    const search = searchParams.get('search');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const clientIdParam = searchParams.get('clientId');
    const cursorParam = searchParams.get('cursor');
    // El primer pedido de la bandeja usa `pagination=cursor` sin cursor; las
    // páginas siguientes envían el cursor opaco que devolvió el API.
    const cursorMode = cursorParam !== null || searchParams.get('pagination') === 'cursor';
    // Parámetros de paginación robustos: valores no numéricos caen a los defaults.
    const parsedPage = parseInt(searchParams.get('page') || '1', 10);
    const parsedLimit = parseInt(
      searchParams.get('limit') || String(DEFAULT_ORDER_API_PAGE_SIZE),
      10,
    );
    const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(MAX_ORDER_PAGE_SIZE, Math.max(1, parsedLimit))
      : DEFAULT_ORDER_API_PAGE_SIZE;

    // Mismos filtros, proyección, populate y permisos que usan las bandejas
    // server-side: la construcción vive en lib/services/order-read.ts.
    const result = await buildOrderListPage(
      auth.session,
      {
        status: statusParam,
        archived: archivedParam,
        search,
        startDate,
        endDate,
        clientId: clientIdParam,
      },
      cursorParam,
      limit,
      { mode: cursorMode ? 'cursor' : 'page', page },
    );

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    if (result.mode === 'cursor') {
      const response: OrderCursorListResponse = {
        success: true,
        orders: result.orders,
        pagination: result.pagination,
      };
      return NextResponse.json(response);
    }

    // Compatibilidad con clientes que todavía usan page/limit.
    const response: OrderListResponse = {
      success: true,
      orders: result.orders,
      pagination: result.pagination,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al listar pedidos:' });
  }
});

/**
 * Respuesta única del alta. Un reintento con la misma clave devuelve el mismo
 * pedido con 200 y `deduplicated: true`; nunca un segundo documento.
 */
function createdOrderResponse(order: unknown, deduplicated = false) {
  const response: OrderMutationResponse = {
    success: true,
    message: deduplicated
      ? 'El pedido ya había sido creado; se devuelve el pedido existente'
      : 'Pedido creado exitosamente en estado borrador',
    order: order as unknown as OrderDTO,
    ...(deduplicated ? { deduplicated: true } : {}),
  };
  return NextResponse.json(response);
}

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin', 'vendedor']);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, createOrderSchema);
    if (!parsedBody.success) return parsedBody.response;

    await dbConnect();

    const {
      clientId,
      items,
      comment,
      invoiceType,
      paymentCondition,
      paymentConditionDetail,
      clientRequestId,
    } = parsedBody.data;

    // El vendedor y su id se toman de la sesión firmada: un `createdBy` del
    // body no puede suplantar a otro usuario.
    const createdBy = auth.session.username;
    const createdById = auth.session.userId;
    const createdByRole = resolveUserRole(auth.session.role, auth.session.username);

    // Reintento inmediato (doble click, timeout o Background Sync): la misma
    // clave del mismo usuario devuelve el pedido ya creado sin volver a
    // consultar cliente/productos ni disparar otra notificación.
    if (clientRequestId) {
      const existing = await findOrderByClientRequestId(createdById, clientRequestId);
      if (existing) return createdOrderResponse(existing, true);
    }

    // El cliente y los productos del pedido no dependen entre sí: una sola
    // vuelta a la base para ambos.
    const requestedProductIds = collectRequestedProductIds(items);
    const [client, products] = await Promise.all([
      Client.findById(clientId).select('code name generalDiscount brandDiscounts'),
      Product.find({ _id: { $in: requestedProductIds } })
        .select('code name price brandId')
        .populate({ path: 'brandId', select: 'name' })
        .lean(),
    ]);

    // Toda la regla comercial (snapshots, descuentos y totales) vive en el
    // servicio puro; la ruta solo consulta y persiste.
    const draft = createOrderDraft({
      clientId,
      client,
      products,
      items,
      createdBy,
      createdById,
      createdByRole,
      comment,
      invoiceType,
      paymentCondition,
      paymentConditionDetail,
      clientRequestId,
    });
    if (!draft.ok) {
      return errorResponse(draft.message, draft.status, orderErrorBody(draft));
    }

    let newOrder;
    try {
      newOrder = await Order.create(draft.value.order);
    } catch (error: unknown) {
      // Carrera entre dos reintentos concurrentes: el índice único deja ganar
      // a uno; el otro devuelve el pedido que ya quedó guardado.
      if (clientRequestId && isDuplicateKeyError(error)) {
        const existing = await findOrderByClientRequestId(createdById, clientRequestId);
        if (existing) return createdOrderResponse(existing, true);
      }
      throw error;
    }

    // Efectos secundarios best-effort fuera del camino crítico: la respuesta
    // sale sin esperar la notificación/SSE. Si el negocio exige no perder
    // alertas, ver el patrón outbox en docs/atomicidad-pedidos.md.
    const notification = {
      ...draft.value.notification,
      orderId: newOrder._id,
    };
    runAfterResponse(() => publishOrderNotification(notification));

    return createdOrderResponse(newOrder);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al crear pedido:' });
  }
});
