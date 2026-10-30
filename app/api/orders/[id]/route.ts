import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import {
  forbiddenResponse,
  requireCurrentRole,
  requireCurrentSession,
  requireSession,
} from '@/lib/auth';
import { canUpdateOrder, resolveUserRole } from '@/lib/authz';
import { canReadOrder } from '@/lib/order-access';
import { Order } from '@/models/Order';
import { Notification } from '@/models/Notification';
import { NotificationRead } from '@/models/NotificationRead';
import { Product } from '@/models/Product';
import { objectIdSchema, updateOrderSchema } from '@/lib/validations';
import { publishOrderNotification } from '@/lib/order-side-effects';
import { runAfterResponse } from '@/lib/after-response';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { getOrderForSession } from '@/lib/services/order-read';
import {
  applyOrderUpdatePlan,
  collectNewProductIds,
  DRAFT_EDIT_BLOCKED_ERROR,
  isDraftOrderIntact,
  orderErrorBody,
  orderVersionConflict,
  planOrderUpdate,
  type OrderServiceError,
} from '@/lib/services/orders';
import type {
  DeleteResponse,
  OrderDetailResponse,
  OrderDTO,
  OrderMutationResponse,
} from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

function serviceErrorResponse(error: OrderServiceError) {
  return errorResponse(error.message, error.status, orderErrorBody(error));
}

export const GET = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = requireSession(request);
      if ('response' in auth) return auth.response;

      const { id } = await params;

      // La lectura, los populate y el permiso por rol viven en el servicio
      // compartido con los Server Components de detalle.
      const result = await getOrderForSession(auth.session, id);
      if (!result.ok) {
        return errorResponse(result.error, result.status);
      }

      const response: OrderDetailResponse = {
        success: true,
        order: result.order,
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al obtener pedido:' });
    }
  },
);

export const PUT = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentSession(request);
      if ('response' in auth) return auth.response;

      const { id } = await params;

      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de pedido inválido', 400);
      }

      const parsedBody = await parseJsonBody(request, updateOrderSchema);
      if (!parsedBody.success) return parsedBody.response;

      const {
        items,
        status,
        comment,
        archived,
        version,
        mode,
        invoiceType,
        paymentCondition,
        paymentConditionDetail,
      } = parsedBody.data;

      const isDraftEdit = mode === 'draft-edit';

      // Autor y rol del comentario salen de la sesión: `author`/`role` del body
      // se descartan para que no se puedan falsificar.
      const author = auth.session.username;
      const role = resolveUserRole(auth.session.role, auth.session.username);

      // Regla por rol: depósito verifica/picking, facturación controla y entrega,
      // vendedor solo comenta/archiva, admin puede todo. La edición de un
      // borrador se termina de autorizar cuando se conoce el pedido (titular +
      // estado intacto), pero los roles operativos quedan afuera desde acá.
      if (isDraftEdit) {
        if (role !== 'admin' && role !== 'vendedor') return forbiddenResponse();
      } else if (!canUpdateOrder(role, { hasItems: Boolean(items), targetStatus: status })) {
        return forbiddenResponse();
      }

      await dbConnect();

      const order = await Order.findById(id).populate(
        'clientId',
        'code name generalDiscount brandDiscounts',
      );
      if (!order) {
        return errorResponse('Pedido no encontrado', 404);
      }

      if (isDraftEdit) {
        const isOwner =
          role === 'admin' ||
          canReadOrder(
            { userId: auth.session.userId, username: auth.session.username, role },
            order,
          );

        if (
          !canUpdateOrder(role, {
            hasItems: true,
            hasCommercialData: true,
            draftEdit: {
              isOwner,
              status: order.status,
              isIntact: isDraftOrderIntact(order),
            },
          })
        ) {
          // Un borrador ajeno es un problema de permisos; uno ya tomado por
          // depósito o con otro estado es un conflicto recuperable.
          if (!isOwner) return forbiddenResponse();
          return errorResponse(DRAFT_EDIT_BLOCKED_ERROR, 409);
        }
      }

      // En el picking el catálogo solo se consulta para las líneas nuevas. La
      // edición de un borrador reemplaza el carrito completo, así que necesita
      // el precio/estado vigente de todos los productos enviados.
      const catalogProductIds = isDraftEdit
        ? [
            ...new Set(
              (items ?? [])
                .map((item) => item.productId)
                .filter((productId): productId is string => productId !== undefined),
            ),
          ]
        : items
          ? collectNewProductIds(order, items)
          : [];

      const catalogProducts =
        catalogProductIds.length > 0
          ? await Product.find({ _id: { $in: catalogProductIds } })
              .select('code name price brandId active')
              .populate({ path: 'brandId', select: 'name' })
              .lean()
          : [];

      // Toda la regla de picking/edición (versión, ítems, totales, estado y
      // guards) vive en el servicio puro; acá solo se aplica el plan.
      const result = planOrderUpdate({
        order,
        client: order.clientId as any,
        catalogProducts,
        items,
        status,
        comment,
        author,
        role,
        archived,
        version,
        draftEdit: isDraftEdit,
        invoiceType,
        paymentCondition,
        paymentConditionDetail,
      });
      if (!result.ok) return serviceErrorResponse(result);

      applyOrderUpdatePlan(order, result.value);

      await order.save();

      // Efectos secundarios best-effort fuera del camino crítico: el pedido ya
      // quedó guardado y la respuesta no espera la notificación/SSE. Para
      // entrega garantizada, ver el patrón outbox en docs/atomicidad-pedidos.md.
      if (result.value.notification) {
        const notification = {
          ...result.value.notification,
          orderId: order._id,
        };
        runAfterResponse(() => publishOrderNotification(notification));
      }

      const response: OrderMutationResponse = {
        success: true,
        message: 'Pedido actualizado exitosamente',
        order: order as unknown as OrderDTO,
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      // Carrera entre el findById y el save: Mongoose no encontró la versión
      // esperada. Es el mismo conflicto optimista, no un error interno.
      if (
        error &&
        typeof error === 'object' &&
        (error as { name?: string }).name === 'VersionError'
      ) {
        return serviceErrorResponse(orderVersionConflict());
      }

      return handleRouteError(error, { context: 'Error al actualizar pedido:' });
    }
  },
);

export const DELETE = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentRole(request, ['admin']);
      if ('response' in auth) return auth.response;

      const { id } = await params;
      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de pedido inválido', 400);
      }

      await dbConnect();

      const deletedOrder = await Order.findByIdAndDelete(id);
      if (!deletedOrder) {
        return errorResponse('Pedido no encontrado', 404);
      }

      // Sin pedido, las notificaciones que lo referencian quedan huérfanas y su
      // "Ver detalle" navega a un 404: se limpian junto con el pedido, y también
      // el estado de lectura por usuario asociado a esas notificaciones.
      const notifications = await Notification.find({ orderId: deletedOrder._id })
        .select('_id')
        .lean();
      if (notifications.length > 0) {
        await NotificationRead.deleteMany({
          notificationId: { $in: notifications.map((notification) => notification._id) },
        });
      }
      await Notification.deleteMany({ orderId: deletedOrder._id });

      const response: DeleteResponse = {
        success: true,
        message: 'Pedido eliminado exitosamente',
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al eliminar pedido:' });
    }
  },
);
