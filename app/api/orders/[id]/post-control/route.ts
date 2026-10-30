import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { forbiddenResponse, requireCurrentSession } from '@/lib/auth';
import { canControlOrderPostItems } from '@/lib/authz';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { Order } from '@/models/Order';
import { objectIdSchema, updateOrderPostControlSchema } from '@/lib/validations';
import {
  orderErrorBody,
  orderVersionConflict,
  planPostControlUpdates,
} from '@/lib/services/orders';
import { resolvePostControl } from '@/lib/order-post-control';
import type { OrderPostControlResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * PATCH /api/orders/[id]/post-control
 *
 * Marca una o más líneas como `ok`/`diferencia` (o vuelve a `pendiente`) sin
 * tocar las cantidades verificadas en depósito. Solo facturación (y admin).
 */
export const PATCH = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentSession(request);
      if ('response' in auth) return auth.response;

      if (!canControlOrderPostItems(auth.session.role)) {
        return forbiddenResponse('Solo facturación puede registrar el control post-factura.');
      }

      const { id } = await params;
      if (!objectIdSchema.safeParse(id).success) {
        return errorResponse('ID de pedido inválido', 400);
      }

      const parsedBody = await parseJsonBody(request, updateOrderPostControlSchema);
      if (!parsedBody.success) return parsedBody.response;

      const { items: updates, version } = parsedBody.data;

      await dbConnect();

      // El plan de control solo lee versión, estado e ids/control de las
      // líneas: no hace falta poblar cliente, marcas ni productos.
      const order = await Order.findById(id);

      if (!order) {
        return errorResponse('Pedido no encontrado', 404);
      }

      // Validar versión, estado y todas las líneas antes de mutar: si una no
      // existe, no se guarda parcialmente el control del resto.
      const result = planPostControlUpdates({ order, version, updates });
      if (!result.ok) {
        return errorResponse(result.message, result.status, orderErrorBody(result));
      }

      const itemById = new Map<string, any>(
        order.items.map((item: any) => [String(item._id), item]),
      );
      for (const assignment of result.value.assignments) {
        itemById.get(assignment.itemId).postControl = assignment.postControl;
      }

      await order.save();

      // Payload liviano: la bandeja de facturación solo necesita la versión y
      // el control por línea para mezclarlo con el detalle ya cargado.
      const response: OrderPostControlResponse = {
        success: true,
        message: 'Control post-factura actualizado exitosamente',
        order: {
          _id: String(order._id),
          status: order.status,
          version: order.version ?? 0,
          items: order.items.map((item: any) => ({
            _id: String(item._id),
            postControl: resolvePostControl(item.postControl),
          })),
        },
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { name?: string }).name === 'VersionError'
      ) {
        const conflict = orderVersionConflict();
        return errorResponse(conflict.message, conflict.status, orderErrorBody(conflict));
      }

      return handleRouteError(error, { context: 'Error al actualizar el control post-factura:' });
    }
  },
);
