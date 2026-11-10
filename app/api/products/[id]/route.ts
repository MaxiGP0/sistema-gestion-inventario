import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole } from '@/lib/auth';
import { buildProductSearchFields } from '@/lib/search-normalize';
import { Product } from '@/models/Product';
import { Brand } from '@/models/Brand';
import { objectIdSchema, productSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import type { DeleteResponse, ProductDTO, ProductMutationResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

export const PUT = withRouteLogging(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireCurrentRole(request, ['admin']);
      if ('response' in auth) return auth.response;

      const { id } = await params;
      const idValidation = objectIdSchema.safeParse(id);
      if (!idValidation.success) {
        return errorResponse('ID de producto inválido', 400);
      }

      const parsedBody = await parseJsonBody(request, productSchema);
      if (!parsedBody.success) return parsedBody.response;

      const { brandId, code, name, price, priceWithIva, imageUrl } = parsedBody.data;

      await dbConnect();

      const brand = await Brand.findById(brandId);
      if (!brand) {
        return errorResponse('La marca seleccionada no existe', 404);
      }

      const numPrice = Number(price);
      const numPriceWithIva =
        priceWithIva !== undefined && priceWithIva !== null && !isNaN(Number(priceWithIva))
          ? Number(priceWithIva)
          : Number((numPrice * 1.21).toFixed(2));

      const trimmedCode = code.trim();
      const trimmedName = name.trim();
      const updatedProduct = await Product.findByIdAndUpdate(
        id,
        {
          brandId,
          code: trimmedCode,
          name: trimmedName,
          ...buildProductSearchFields({
            code: trimmedCode,
            name: trimmedName,
            brandName: brand.name,
          }),
          price: numPrice,
          priceWithIva: numPriceWithIva,
          imageUrl: imageUrl?.trim() || '',
        },
        { new: true, runValidators: true },
      );

      if (!updatedProduct) {
        return errorResponse('Producto no encontrado', 404);
      }

      revalidateCatalog('products');

      const response: ProductMutationResponse = {
        success: true,
        message: 'Producto actualizado exitosamente',
        product: updatedProduct as unknown as ProductDTO,
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, {
        context: 'Error al actualizar producto:',
        duplicateMessages: {
          'brandId+code': 'Ya existe un producto con ese código para la marca seleccionada',
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
        return errorResponse('ID de producto inválido', 400);
      }

      await dbConnect();

      // Baja lógica: el producto sale del catálogo pero sigue resolviéndose en
      // pedidos históricos (un hard delete dejaba items.productId en null).
      const deletedProduct = await Product.findByIdAndUpdate(id, { active: false }, { new: true });
      if (!deletedProduct) {
        return errorResponse('Producto no encontrado', 404);
      }

      revalidateCatalog('products');

      const response: DeleteResponse = {
        success: true,
        message: 'Producto eliminado exitosamente',
      };
      return NextResponse.json(response);
    } catch (error: unknown) {
      return handleRouteError(error, { context: 'Error al eliminar producto:' });
    }
  },
);
