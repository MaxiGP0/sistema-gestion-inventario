import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { forbiddenResponse, requireCurrentSession } from '@/lib/auth';
import { canCreateClient } from '@/lib/authz';
import { buildClientSearchFilter } from '@/lib/search-query';
import { Client } from '@/models/Client';
import { clientListQuerySchema, clientSchema } from '@/lib/validations';
import { handleRouteError, parseJsonBody, parseQueryParams } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import { catalogCacheHeaders } from '@/lib/catalog-http-cache';
import type { ClientDTO, ClientListResponse, ClientMutationResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

// El listado y el autocompletado sólo usan estos campos; createdAt/updatedAt
// viajaban en cada documento sin que ningún consumidor los leyera.
const CLIENT_LIST_FIELDS = 'code name address localidad province generalDiscount brandDiscounts';

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedQuery = parseQueryParams(request, clientListQuerySchema);
    if (!parsedQuery.success) return parsedQuery.response;

    const { search: searchParam, q, page, limit } = parsedQuery.data;
    const search = searchParam ?? q ?? '';
    const skip = (page - 1) * limit;

    await dbConnect();

    // Búsqueda por prefijo indexada sobre las claves normalizadas. El fallback
    // para documentos históricos sin `search*` viaja en la misma consulta bajo
    // `$exists: false`; después del backfill esa rama no devuelve documentos.
    const searchFilter = buildClientSearchFilter(search);
    const query = searchFilter ?? {};

    const [clients, total] = await Promise.all([
      Client.find(query)
        .select(CLIENT_LIST_FIELDS)
        .sort({ name: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Client.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    const response: ClientListResponse = {
      success: true,
      clients: clients as unknown as ClientDTO[],
      total,
      page,
      limit,
      totalPages,
    };
    return NextResponse.json(response, { headers: catalogCacheHeaders('clients') });
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al listar clientes:' });
  }
});

export const POST = withRouteLogging(async (request: Request) => {
  try {
    // El alta rápida forma parte del flujo de pedidos: admin y vendedor pueden
    // crear la ficha. Editar y eliminar siguen reservados al backoffice admin.
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;
    if (!canCreateClient(auth.session.role)) return forbiddenResponse();

    const parsedBody = await parseJsonBody(request, clientSchema);
    if (!parsedBody.success) return parsedBody.response;

    await dbConnect();

    const { code, name, address, localidad, province, generalDiscount, brandDiscounts } =
      parsedBody.data;
    const resolvedLocalidad = localidad || '';

    const client = await Client.findOneAndUpdate(
      { code: code.trim() },
      {
        code: code.trim(),
        name: name.trim(),
        address: address?.trim() || '',
        localidad: resolvedLocalidad.trim(),
        province: province?.trim() || '',
        generalDiscount: Number(generalDiscount) || 0,
        brandDiscounts: brandDiscounts || [],
      },
      { upsert: true, new: true, runValidators: true },
    );

    revalidateCatalog('clients');

    const response: ClientMutationResponse = {
      success: true,
      message: 'Cliente guardado exitosamente',
      client: client as unknown as ClientDTO,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al guardar cliente:',
      duplicateMessages: {
        code: 'Ya existe un cliente con ese código',
      },
    });
  }
});
