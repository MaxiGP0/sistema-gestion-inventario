import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole, requireCurrentSession } from '@/lib/auth';
import { buildBrandSearchFilter, buildProductSearchFilter } from '@/lib/search-query';
import { buildProductSearchFields } from '@/lib/search-normalize';
import { Product } from '@/models/Product';
import { Brand } from '@/models/Brand';
import { productListQuerySchema, productSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody, parseQueryParams } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import { catalogCacheHeaders } from '@/lib/catalog-http-cache';
import type { ProductDTO, ProductListResponse, ProductMutationResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

const MAX_IDS = 200;

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedQuery = parseQueryParams(request, productListQuerySchema);
    if (!parsedQuery.success) return parsedQuery.response;

    const { search = '', page, limit } = parsedQuery.data;
    const { searchParams } = new URL(request.url);
    const brandId = searchParams.get('brandId');
    const idsParam = (searchParams.get('ids') || '').trim();
    const skip = (page - 1) * limit;

    await dbConnect();

    const query: Record<string, unknown> = {};

    if (brandId && mongoose.isValidObjectId(brandId)) {
      query.brandId = brandId;
    }

    // Soporte para recuperar un conjunto explícito de productos (ej: restaurar borrador de pedido)
    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map((s) => s.trim())
        .filter((s) => mongoose.isValidObjectId(s))
        .slice(0, MAX_IDS);
      query._id = { $in: ids };
    } else {
      // Los productos dados de baja (soft delete) salen del catálogo, pero se
      // siguen resolviendo por ids para no romper borradores/pedidos históricos.
      query.active = { $ne: false };
    }

    // Búsqueda por prefijo indexado en nombre/código y en el nombre normalizado
    // de la marca. Los tokens de la marca ya viven en Product.searchTokens; las
    // marcas resueltas quedan para el fallback de documentos históricos.
    if (search) {
      const brandFilter = buildBrandSearchFilter(search);
      const matchingBrands = brandFilter
        ? await Brand.find(brandFilter).select('_id name').lean()
        : [];
      const searchFilter = buildProductSearchFilter(search, matchingBrands);
      if (searchFilter) Object.assign(query, searchFilter);
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('_id brandId code name imageUrl price priceWithIva')
        .populate('brandId', 'name codePrefix')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(query),
    ]);

    const response: ProductListResponse = {
      success: true,
      products: products as unknown as ProductDTO[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      hasMore: skip + products.length < total,
    };
    return NextResponse.json(response, { headers: catalogCacheHeaders('products') });
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al listar productos:' });
  }
});

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    await dbConnect();

    const parsedBody = await parseJsonBody(request, productSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { brandId, code, name, price, priceWithIva, imageUrl } = parsedBody.data;

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
    const product = await Product.findOneAndUpdate(
      { brandId, code: trimmedCode },
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
        active: true,
      },
      { upsert: true, new: true, runValidators: true },
    );

    revalidateCatalog('products');

    const response: ProductMutationResponse = {
      success: true,
      message: 'Producto guardado exitosamente',
      product: product as unknown as ProductDTO,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al guardar producto:',
      duplicateMessages: {
        'brandId+code': 'Ya existe un producto con ese código para la marca seleccionada',
      },
    });
  }
});
