import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole, requireSession } from '@/lib/auth';
import { buildBrandSearchFilter, buildProductSearchFilter } from '@/lib/search-query';
import { Product } from '@/models/Product';
import { Brand } from '@/models/Brand';
import { productSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import { catalogCacheHeaders } from '@/lib/catalog-http-cache';
import type { ProductDTO, ProductListResponse, ProductMutationResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_IDS = 200;

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = requireSession(request);
    if ('response' in auth) return auth.response;

    await dbConnect();
    const { searchParams } = new URL(request.url);
    const brandId = searchParams.get('brandId');
    const search = (searchParams.get('search') || '').trim();
    const idsParam = (searchParams.get('ids') || '').trim();

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const limitRaw = parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw));
    const skip = (page - 1) * limit;

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
    // de la marca. El fallback para documentos históricos queda en la consulta.
    if (search) {
      const brandFilter = buildBrandSearchFilter(search);
      const matchingBrands = brandFilter ? await Brand.find(brandFilter).select('_id').lean() : [];
      const searchFilter = buildProductSearchFilter(
        search,
        matchingBrands.map((brand) => brand._id),
      );
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

    const product = await Product.findOneAndUpdate(
      { brandId, code: code.trim() },
      {
        brandId,
        code: code.trim(),
        name: name.trim(),
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
