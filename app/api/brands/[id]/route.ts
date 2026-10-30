import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole } from '@/lib/auth';
import { Brand } from '@/models/Brand';
import { Client } from '@/models/Client';
import { Product } from '@/models/Product';
import { brandSchema, objectIdSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import type { BrandDTO, BrandMutationResponse, DeleteResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

export const PUT = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentRole(request, ['admin']);
      if ('response' in auth) return auth.response;

      const { id } = await params;
      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de marca inválido', 400);
      }

      const parsedBody = await parseJsonBody(request, brandSchema);
      if (!parsedBody.success) return parsedBody.response;

      const { name, codePrefix } = parsedBody.data;

      await dbConnect();

      const updatedBrand = await Brand.findByIdAndUpdate(
        id,
        { name, codePrefix: codePrefix?.trim() || '' },
        { new: true, runValidators: true },
      );

      if (!updatedBrand) {
        return errorResponse('Marca no encontrada', 404);
      }

      // El nombre de la marca se embebe en el populate del listado de productos.
      revalidateCatalog('brands', 'products');

      const response: BrandMutationResponse = {
        success: true,
        message: 'Marca actualizada exitosamente',
        brand: updatedBrand as unknown as BrandDTO,
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, {
        context: 'Error al actualizar marca:',
        duplicateMessages: {
          name: 'Ya existe una marca con ese nombre',
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
        return errorResponse('ID de marca inválido', 400);
      }

      await dbConnect();

      // Verificar si hay productos asociados a esta marca
      const productsCount = await Product.countDocuments({ brandId: id });
      if (productsCount > 0) {
        return errorResponse(
          `No se puede eliminar la marca porque tiene ${productsCount} productos asociados.`,
          400,
        );
      }

      // Los clientes con descuentos por marca también la referencian: sin el
      // chequeo, el populate de brandDiscounts.brandId quedaba en null.
      const clientsCount = await Client.countDocuments({ 'brandDiscounts.brandId': id });
      if (clientsCount > 0) {
        return errorResponse(
          `No se puede eliminar la marca porque ${clientsCount} cliente(s) la usan en sus descuentos.`,
          400,
        );
      }

      const deletedBrand = await Brand.findByIdAndDelete(id);
      if (!deletedBrand) {
        return errorResponse('Marca no encontrada', 404);
      }

      revalidateCatalog('brands', 'products');

      const response: DeleteResponse = {
        success: true,
        message: 'Marca eliminada exitosamente',
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al eliminar marca:' });
    }
  },
);
