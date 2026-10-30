import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { forbiddenResponse, requireCurrentRole } from '@/lib/auth';
import { resolveUserRole } from '@/lib/authz';
import { Client } from '@/models/Client';
import { Order } from '@/models/Order';
import { Product } from '@/models/Product';
import { objectIdSchema } from '@/lib/validations';
import { errorResponse, handleRouteError } from '@/lib/api-errors';
import { canReadOrder } from '@/lib/order-access';
import {
  findOrderByClientRequestId,
  isDuplicateKeyError,
  parseClientRequestId,
} from '@/lib/order-idempotency';
import { publishOrderNotification } from '@/lib/order-side-effects';
import { runAfterResponse } from '@/lib/after-response';
import {
  collectDuplicateProductIds,
  duplicateOrderDraft,
  orderErrorBody,
} from '@/lib/services/orders';
import type { DuplicateOmittedItemDTO, OrderDTO, OrderDuplicateResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

function duplicateResponse(
  order: unknown,
  omittedItems: DuplicateOmittedItemDTO[],
  deduplicated = false,
) {
  const response: OrderDuplicateResponse = {
    success: true,
    message: deduplicated
      ? 'El pedido ya había sido duplicado; se devuelve el borrador existente'
      : 'Pedido duplicado exitosamente en estado borrador',
    order: order as unknown as OrderDTO,
    omittedItems,
    ...(deduplicated ? { deduplicated: true } : {}),
  };
  return NextResponse.json(response);
}

export const POST = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentRole(request, ['admin', 'vendedor']);
      if ('response' in auth) return auth.response;

      const { id } = await params;
      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de pedido inválido', 400);
      }

      const clientRequestId = parseClientRequestId(request.headers.get('idempotency-key'));
      if (clientRequestId === undefined) {
        return errorResponse('La clave de idempotencia es inválida', 400);
      }

      await dbConnect();

      // Reintento inmediato (doble click, timeout de red): la clave ya tiene
      // un pedido creado por este usuario y no se vuelve a copiar.
      if (clientRequestId) {
        const existing = await findOrderByClientRequestId(auth.session.userId, clientRequestId);
        if (existing) return duplicateResponse(existing, [], true);
      }

      const source = await Order.findById(id)
        .select(
          'clientId items.productId items.requestedQuantity items.productCode items.productName ' +
            'invoiceType paymentCondition paymentConditionDetail createdById createdBy',
        )
        .lean();
      if (!source) {
        return errorResponse('Pedido no encontrado', 404);
      }

      // El vendedor sólo puede duplicar pedidos propios; admin, cualquiera.
      if (!canReadOrder(auth.session, source)) {
        return forbiddenResponse();
      }

      const productIds = collectDuplicateProductIds(source.items ?? []);
      const [client, products] = await Promise.all([
        Client.findById(source.clientId).select('code name generalDiscount brandDiscounts'),
        Product.find({ _id: { $in: productIds } })
          .select('code name price brandId active')
          .populate({ path: 'brandId', select: 'name' })
          .lean(),
      ]);

      const plan = duplicateOrderDraft({
        source: {
          clientId: String(source.clientId),
          items: source.items ?? [],
          invoiceType: source.invoiceType,
          paymentCondition: source.paymentCondition,
          paymentConditionDetail: source.paymentConditionDetail,
        },
        client,
        products,
        createdBy: auth.session.username,
        createdById: auth.session.userId,
        createdByRole: resolveUserRole(auth.session.role, auth.session.username),
        clientRequestId,
      });
      if (!plan.ok) {
        return errorResponse(plan.message, plan.status, orderErrorBody(plan));
      }

      let newOrder;
      try {
        newOrder = await Order.create(plan.value.order);
      } catch (error: unknown) {
        // Carrera entre dos reintentos concurrentes: el índice único deja
        // ganar a uno; el otro devuelve el pedido que ya quedó guardado.
        if (clientRequestId && isDuplicateKeyError(error)) {
          const existing = await findOrderByClientRequestId(auth.session.userId, clientRequestId);
          if (existing) return duplicateResponse(existing, [], true);
        }
        throw error;
      }

      const notification = {
        ...plan.value.notification,
        orderId: newOrder._id,
      };
      runAfterResponse(() => publishOrderNotification(notification));

      return duplicateResponse(newOrder, plan.value.omittedItems);
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al duplicar pedido:' });
    }
  },
);
