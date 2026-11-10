/**
 * Construcción compartida del filtro de pedidos.
 *
 * GET /api/orders y GET /api/orders/export deben aplicar exactamente los mismos
 * filtros y permisos; mantener la construcción en un solo módulo evita que una
 * exportación muestre pedidos que el listado no devuelve (o al revés).
 */

import { objectIdSchema, parseDateFilterValue } from './validations';
import { buildOrderReadFilter, type OrderAccessSession } from './order-access';
import { escapeRegex } from './escape-regex';
import { orderShortId, ORDER_SHORT_ID_LENGTH } from './order-short-id';
import { buildTokenSearchFilter, ORDER_SEARCH_FIELDS } from './search-query';

/** Query params que aceptan el listado y la exportación de pedidos. */
export interface OrderListFilterInput {
  status?: string | null;
  /** 'true' | 'false' | 'all' */
  archived?: string | null;
  search?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  clientId?: string | null;
}

export type OrderListQueryResult =
  { ok: true; query: Record<string, any> } | { ok: false; error: string };

/**
 * Reconoce un código corto (`#a1b2c3`) o un fragmento hexadecimal de 4 a 24
 * caracteres. Devuelve el token en minúsculas, sin `#`, o `null` si el término
 * debe tratarse como búsqueda de texto normal.
 */
export function parseOrderShortSearch(term: string): string | null {
  const match = /^#?([0-9a-f]{4,24})$/i.exec(term.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Búsqueda por tokens normalizados sobre `searchTokens`.
 *
 * Usa el mismo filtro multikey que clientes y productos. Los pedidos históricos
 * sin `searchTokens` caen al fallback con regex `i` sobre los snapshots del
 * cliente, el vendedor y las líneas (`items.productName`/`items.productCode`).
 */
export function buildOrderTokenSearchFilter(term: string): Record<string, unknown> | null {
  return buildTokenSearchFilter(term, ORDER_SEARCH_FIELDS);
}

/**
 * Filtro para un fragmento hexadecimal que no es un ObjectId completo.
 *
 * - Los 6 caracteres del código visible buscan directo en `shortId` (indexado).
 * - Un fragmento más largo también puede ser el prefijo de un ObjectId.
 * - Los pedidos históricos sin `shortId` se resuelven comparando el sufijo del
 *   `_id` con la expresión indicada.
 */
export function buildOrderShortSearchFilter(token: string): Record<string, unknown> {
  const escaped = escapeRegex(token);
  const isShortCode = token.length === ORDER_SHORT_ID_LENGTH;

  const shortIdCondition =
    token.length < ORDER_SHORT_ID_LENGTH
      ? { shortId: new RegExp(`^${escaped}`) }
      : { shortId: isShortCode ? token : orderShortId(token) };

  const historicalSuffix = {
    shortId: { $exists: false },
    $expr: {
      $regexMatch: {
        input: { $toLower: { $toString: '$_id' } },
        regex: `${escaped}$`,
      },
    },
  };

  return {
    $or: [
      shortIdCondition,
      // Permite pegar el inicio de un ObjectId sin completar los 24 caracteres.
      // Se usa `$expr` porque Mongoose 9 no castea un RegExp sobre `_id`.
      {
        $expr: {
          $regexMatch: {
            input: { $toLower: { $toString: '$_id' } },
            regex: `^${escaped}`,
          },
        },
      },
      historicalSuffix,
    ],
  };
}

/**
 * Agrega una restricción de búsqueda sin pisar el `$or` del alcance por rol.
 */
function appendOrderSearchFilter(
  query: Record<string, any>,
  condition: Record<string, unknown>,
): void {
  query.$and = [...(query.$and ?? []), condition];
}

/**
 * Arma el filtro Mongo del listado a partir de la sesión y los query params.
 *
 * Devuelve un resultado discriminado porque un `clientId` inválido es un error
 * de validación (400) y no una consulta vacía.
 */
export function buildOrderListQuery(
  session: OrderAccessSession,
  filters: OrderListFilterInput,
): OrderListQueryResult {
  const query: Record<string, any> = {};

  // El vendedor sólo lista sus pedidos (por id o, en históricos, username).
  // Admin/controlador/billing conservan el alcance completo.
  const readFilter = buildOrderReadFilter(session);
  if (readFilter) Object.assign(query, readFilter);

  if (filters.status) {
    if (filters.status.includes(',')) {
      query.status = { $in: filters.status.split(',').map((s) => s.trim()) };
    } else {
      query.status = filters.status;
    }
  }

  if (filters.archived === 'true') {
    query.archived = true;
  } else if (filters.archived === 'all') {
    // Include all archived and non-archived
  } else {
    // Default: exclude archived orders. Use exact equality so the
    // { archived, status, createdAt, _id } compound index is used.
    query.archived = false;
  }

  if (filters.startDate || filters.endDate) {
    const startDate = filters.startDate ? parseDateFilterValue(filters.startDate) : null;
    const endDate = filters.endDate ? parseDateFilterValue(filters.endDate) : null;

    // Una URL vieja o mal formada no debe llegar a Mongoose como Invalid Date:
    // se responde como error de validación (400) desde las rutas.
    if ((filters.startDate && !startDate) || (filters.endDate && !endDate)) {
      return { ok: false, error: 'Rango de fechas inválido' };
    }

    query.createdAt = {};
    if (startDate) query.createdAt.$gte = startDate;
    if (endDate) {
      // Los presets de la bandeja mandan instantes ISO completos (con `T`) y
      // deben respetarse tal cual. Las fechas sueltas (`YYYY-MM-DD`) conservan
      // el comportamiento histórico: incluyen hasta el fin de ese día.
      if (!filters.endDate!.includes('T')) {
        endDate.setHours(23, 59, 59, 999);
      }
      query.createdAt.$lte = endDate;
    }
  }

  if (filters.clientId !== null && filters.clientId !== undefined) {
    const parsedClientId = objectIdSchema.safeParse(filters.clientId);
    if (!parsedClientId.success) {
      return { ok: false, error: 'El clientId debe ser un ObjectId válido' };
    }
    // "Repetir último pedido" pide `clientId` + `limit=1` y ordena por fecha.
    query.clientId = parsedClientId.data;
  }

  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim();
    const shortSearch = parseOrderShortSearch(term);
    const tokenSearch = buildOrderTokenSearchFilter(term);

    if (shortSearch && shortSearch.length === 24) {
      // ObjectId completo pegado: atajo directo por _id.
      query._id = shortSearch;
    } else if (
      shortSearch &&
      (term.startsWith('#') || shortSearch.length > ORDER_SHORT_ID_LENGTH)
    ) {
      // `#xxxxxx` explícito o prefijo de ObjectId: no hay ambigüedad.
      appendOrderSearchFilter(query, buildOrderShortSearchFilter(shortSearch));
    } else if (shortSearch) {
      // Un token hexadecimal de 4 a 6 caracteres puede ser el código corto del
      // pedido o parte de un código/nombre de cliente o producto ("cafe").
      // Se combinan ambas ramas con OR para no perder ninguno de los dos casos.
      appendOrderSearchFilter(query, {
        $or: [buildOrderShortSearchFilter(shortSearch), ...(tokenSearch ? [tokenSearch] : [])],
      });
    } else if (tokenSearch) {
      appendOrderSearchFilter(query, tokenSearch);
    } else {
      // El término sólo traía signos: no hay tokens que buscar.
      query._id = null;
    }
  }

  return { ok: true, query };
}
