import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole, requireCurrentSession } from '@/lib/auth';
import { Brand } from '@/models/Brand';
import { brandSchema } from '@/lib/validations';
import { handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import { catalogCacheHeaders } from '@/lib/catalog-http-cache';
import type { BrandDTO, BrandListResponse, BrandMutationResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    await dbConnect();
    const brands = await Brand.find({}).sort({ name: 1 }).lean();
    const response: BrandListResponse = {
      success: true,
      brands: brands as unknown as BrandDTO[],
    };
    return NextResponse.json(response, { headers: catalogCacheHeaders('brands') });
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al listar marcas:' });
  }
});

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, brandSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { name, codePrefix } = parsedBody.data;

    await dbConnect();

    const brand = await Brand.create({
      name,
      codePrefix: codePrefix?.trim() || '',
    });

    revalidateCatalog('brands');

    const response: BrandMutationResponse = {
      success: true,
      message: 'Marca creada exitosamente',
      brand: brand as unknown as BrandDTO,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al crear marca:',
      duplicateMessages: {
        name: 'Ya existe una marca con ese nombre',
      },
    });
  }
});
