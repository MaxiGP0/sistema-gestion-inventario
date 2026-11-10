import { NextResponse } from 'next/server';
import type { Types } from 'mongoose';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole } from '@/lib/auth';
import { Brand } from '@/models/Brand';
import { Client } from '@/models/Client';
import { Product } from '@/models/Product';
import { buildProductSearchFields } from '@/lib/search-normalize';
import { brandSchema, objectIdSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import type { BrandDTO, BrandMutationResponse, DeleteResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

const PRODUCT_UPDATE_CHUNK_SIZE = 500;

interface LeanBrandProduct {
  _id: Types.ObjectId;
  code: string;
  name: string;
}

/**
 * Recalcula `searchTokens` de todos los productos de una marca renombrada.
 *
 * `bulkWrite` no ejecuta los hooks del schema, por eso el array se calcula con
 * el nombre nuevo y se persiste junto con `updatedAt`: el snapshot offline
 * incremental detecta el cambio y recibe también el nombre de marca actualizado
 * que se embebe al poblar `brandId`.
 */
async function refreshProductBrandTokens(brand: {
  _id: Types.ObjectId;
  name: string;
}): Promise<void> {
  const products = (await Product.find({ brandId: brand._id })
    .select('_id code name')
    .lean()) as unknown as LeanBrandProduct[];
  if (products.length === 0) return;

  const updatedAt = new Date();
  const operations = products.map((product) => ({
    updateOne: {
      filter: { _id: product._id },
      update: {
        $set: {
          searchTokens: buildProductSearchFields({
            code: product.code,
            name: product.name,
            brandName: brand.name,
          }).searchTokens,
          updatedAt,
        },
      },
    },
  }));

  for (let index = 0; index < operations.length; index += PRODUCT_UPDATE_CHUNK_SIZE) {
    await Product.bulkWrite(operations.slice(index, index + PRODUCT_UPDATE_CHUNK_SIZE), {
      ordered: false,
    });
  }
}

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

      const currentBrand = await Brand.findById(id).select('name').lean();
      if (!currentBrand) {
        return errorResponse('Marca no encontrada', 404);
      }

      const updatedBrand = await Brand.findByIdAndUpdate(
        id,
        { name, codePrefix: codePrefix?.trim() || '' },
        { new: true, runValidators: true },
      );

      if (!updatedBrand) {
        return errorResponse('Marca no encontrada', 404);
      }

      // Los productos indexan el nombre de la marca dentro de `searchTokens`:
      // al renombrarla hay que reemplazar el token viejo por el nuevo.
      if (currentBrand.name !== updatedBrand.name) {
        await refreshProductBrandTokens(updatedBrand);
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

      // Los productos dados de baja (active: false) ya no forman parte del
      // catálogo: sólo bloquean la baja de la marca los que siguen activos.
      const activeProductsCount = await Product.countDocuments({
        brandId: id,
        active: { $ne: false },
      });
      if (activeProductsCount > 0) {
        return errorResponse(
          `No se puede eliminar la marca porque tiene ${activeProductsCount} productos asociados.`,
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
