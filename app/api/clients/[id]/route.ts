import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole, requireSession } from '@/lib/auth';
import { Client } from '@/models/Client';
import { Order } from '@/models/Order';
import { getClientById } from '@/lib/catalog';
import { catalogCacheHeaders } from '@/lib/catalog-http-cache';
import { clientSchema, objectIdSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import type {
  ClientDetailResponse,
  ClientDTO,
  ClientMutationResponse,
  DeleteResponse,
} from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/** Ficha puntual para reabrir el alta con `?clientId=` desde el cliente. */
export const GET = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = requireSession(request);
      if ('response' in auth) return auth.response;

      const { id } = await params;
      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de cliente inválido', 400);
      }

      const client = await getClientById(id);
      if (!client) {
        return errorResponse('Cliente no encontrado', 404);
      }

      const response: ClientDetailResponse = { success: true, client };
      return NextResponse.json(response, { headers: catalogCacheHeaders('clients') });
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al obtener cliente:' });
    }
  },
);

export const PUT = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentRole(request, ['admin']);
      if ('response' in auth) return auth.response;

      const { id } = await params;

      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de cliente inválido', 400);
      }

      const parsedBody = await parseJsonBody(request, clientSchema);
      if (!parsedBody.success) return parsedBody.response;

      const { code, name, address, localidad, province, generalDiscount, brandDiscounts } =
        parsedBody.data;
      const resolvedLocalidad = localidad || '';

      await dbConnect();

      const updatedClient = await Client.findByIdAndUpdate(
        id,
        {
          code: code.trim(),
          name: name.trim(),
          address: address?.trim() || '',
          localidad: resolvedLocalidad.trim(),
          province: province?.trim() || '',
          generalDiscount: Number(generalDiscount) || 0,
          brandDiscounts: brandDiscounts || [],
        },
        { new: true, runValidators: true },
      );

      if (!updatedClient) {
        return errorResponse('Cliente no encontrado', 404);
      }

      revalidateCatalog('clients');

      const response: ClientMutationResponse = {
        success: true,
        message: 'Cliente actualizado exitosamente',
        client: updatedClient as unknown as ClientDTO,
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, {
        context: 'Error al actualizar cliente:',
        duplicateMessages: {
          code: 'Ya existe un cliente con ese código',
        },
      });
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
        return errorResponse('ID de cliente inválido', 400);
      }

      await dbConnect();

      // Verificar si el cliente tiene pedidos asociados
      const ordersCount = await Order.countDocuments({ clientId: id });
      if (ordersCount > 0) {
        return errorResponse(
          `No se puede eliminar el cliente porque tiene ${ordersCount} pedidos registrados.`,
          400,
        );
      }

      const deletedClient = await Client.findByIdAndDelete(id);
      if (!deletedClient) {
        return errorResponse('Cliente no encontrado', 404);
      }

      revalidateCatalog('clients');

      const response: DeleteResponse = {
        success: true,
        message: 'Cliente eliminado exitosamente',
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al eliminar cliente:' });
    }
  },
);
