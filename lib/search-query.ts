/**
 * Construcción de filtros de búsqueda por tokens.
 *
 * La consulta indexada exige que todos los tokens del término coincidan como
 * prefijo de alguna palabra del array multikey `searchTokens`
 * (`$all: [/^token1/, /^token2/]`). Así "ahorro" encuentra "Supermercado El
 * Ahorro" y "shampoo 400" encuentra "Shampoo NovaFarma 400ml", sin importar la
 * posición de las palabras.
 *
 * Los productos incluyen el nombre de su marca en `searchTokens`, por lo que
 * "biosalud 400" se resuelve en una sola consulta al índice multikey. Las marcas
 * resueltas aparte quedan para los documentos históricos que todavía no tienen
 * los tokens de la marca.
 *
 * Los documentos históricos que todavía no tienen `searchTokens` conservan el
 * camino anterior (prefijo sobre los campos `search*` y, si tampoco existen,
 * regex `i` sobre los campos originales) dentro de una rama `$exists: false`.
 * Una vez ejecutado el backfill esa rama no devuelve documentos.
 */

import { escapeRegex } from './escape-regex';
import { normalizeSearchText, tokenizeSearchText } from './search-normalize';

export interface PrefixSearchField {
  /** Campo normalizado indexado (minúsculas, sin acentos). */
  normalized?: string;
  /** Campo original, sólo para el fallback de documentos históricos. */
  legacy: string;
}

export const CLIENT_SEARCH_FIELDS: readonly PrefixSearchField[] = [
  { normalized: 'searchName', legacy: 'name' },
  { normalized: 'searchCode', legacy: 'code' },
  { normalized: 'searchLocalidad', legacy: 'localidad' },
  { normalized: 'searchProvince', legacy: 'province' },
  { normalized: 'searchAddress', legacy: 'address' },
];

export const PRODUCT_SEARCH_FIELDS: readonly PrefixSearchField[] = [
  { normalized: 'searchName', legacy: 'name' },
  { normalized: 'searchCode', legacy: 'code' },
];

export const BRAND_SEARCH_FIELDS: readonly PrefixSearchField[] = [
  { normalized: 'searchName', legacy: 'name' },
];

/**
 * Campos históricos de pedidos. No existen claves normalizadas por campo: la
 * rama de compatibilidad compara directamente con regex `i` sobre los snapshots
 * (`clientName`, `clientCode`, `createdBy` e ítems) de los pedidos viejos.
 */
export const ORDER_SEARCH_FIELDS: readonly PrefixSearchField[] = [
  { legacy: 'clientName' },
  { legacy: 'clientCode' },
  { legacy: 'createdBy' },
  { legacy: 'items.productName' },
  { legacy: 'items.productCode' },
];

export interface SearchToken {
  /** Token original, con acentos, para el regex legado. */
  raw: string;
  /** Token normalizado (minúsculas, sin acentos) para las claves indexadas. */
  normalized: string;
}

/** Tope de costo por búsqueda: cantidad y longitud de tokens. */
export const MAX_SEARCH_TOKENS = 8;
export const MAX_SEARCH_TOKEN_LENGTH = 40;

/**
 * Divide el término en tokens únicos; conserva el original para el fallback.
 *
 * Una URL puede traer cientos de palabras o un token gigante: sólo se aceptan
 * 8 tokens únicos de hasta 40 caracteres. Si no queda ninguno, devuelve `null`
 * para que la consulta no genere regex ni documentos desproporcionados.
 */
export function splitSearchTokens(term: string): SearchToken[] | null {
  const tokens: SearchToken[] = [];
  const seen = new Set<string>();

  for (const raw of String(term ?? '')
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    const normalized = normalizeSearchText(raw);
    if (!normalized || normalized.length > MAX_SEARCH_TOKEN_LENGTH || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tokens.push({ raw, normalized });
    if (tokens.length >= MAX_SEARCH_TOKENS) break;
  }

  return tokens.length > 0 ? tokens : null;
}

/** Regex anclada que puede acotarse con un índice B-tree/multikey. */
export function buildPrefixRegex(term: string): RegExp {
  return new RegExp(`^${escapeRegex(normalizeSearchText(term))}`);
}

/** Regex legado para documentos sin los campos normalizados. */
export function buildLegacySearchRegex(term: string): RegExp {
  return new RegExp(escapeRegex(term.trim()), 'i');
}

function buildTokenRegex(token: string): RegExp {
  return new RegExp(`^${escapeRegex(token)}`);
}

/**
 * Condición de cada token para un documento histórico: prefijo en cualquiera
 * de las claves normalizadas o, si tampoco existen, regex `i` en el campo
 * original. Todos los tokens se combinan con `$and` para exigir coincidencia
 * completa aunque las palabras estén en campos distintos.
 */
function buildHistoricalTokenConditions(
  tokens: readonly SearchToken[],
  fields: readonly PrefixSearchField[],
): Record<string, unknown>[] {
  return tokens.map(({ raw, normalized }) => {
    const prefix = buildTokenRegex(normalized);
    const legacy = buildLegacySearchRegex(raw);

    return {
      $or: [
        ...fields.flatMap(({ normalized: field }) => (field ? [{ [field]: prefix }] : [])),
        ...fields.map(({ normalized: field, legacy: legacyField }) => ({
          ...(field ? { [field]: { $exists: false } } : {}),
          [legacyField]: legacy,
        })),
      ],
    };
  });
}

/**
 * Filtro de búsqueda multi-token sobre productos o clientes.
 *
 * - Rama principal: `searchTokens: { $all: [/^token.../] }` (multikey).
 * - Rama histórica: documentos sin `searchTokens`, resueltos con los campos
 *   normalizados anteriores o con los campos originales.
 */
export function buildTokenSearchFilter(
  term: string,
  fields: readonly PrefixSearchField[],
  tokenField = 'searchTokens',
): Record<string, unknown> | null {
  const tokens = splitSearchTokens(term);
  if (!tokens) return null;

  return {
    $or: [
      { [tokenField]: { $all: tokens.map(({ normalized }) => buildTokenRegex(normalized)) } },
      {
        [tokenField]: { $exists: false },
        $and: buildHistoricalTokenConditions(tokens, fields),
      },
    ],
  };
}

/**
 * Filtro `$or` con una rama indexada por campo más el fallback de documentos
 * históricos. Se conserva para marcas, que mantienen un único nombre
 * normalizado. Devuelve `null` si el término no tiene contenido buscable.
 */
export function buildPrefixSearchFilter(
  term: string,
  fields: readonly PrefixSearchField[],
): Record<string, unknown> | null {
  const normalized = normalizeSearchText(term);
  if (!normalized) return null;

  const prefix = buildPrefixRegex(term);
  const legacy = buildLegacySearchRegex(term);
  const conditions = fields.flatMap(({ normalized: field, legacy: legacyField }) => [
    ...(field ? [{ [field]: prefix }] : []),
    { ...(field ? { [field]: { $exists: false } } : {}), [legacyField]: legacy },
  ]);

  return { $or: conditions };
}

/**
 * Filtro de marcas para resolver los `brandId` de una búsqueda de productos.
 *
 * A diferencia de la versión anterior, compara cada token del término contra el
 * prefijo de `searchName`: buscar "biosalud 400" encuentra "BioSalud" porque el
 * token "biosalud" coincide, aunque el término completo no sea un prefijo del
 * nombre. Los documentos históricos conservan el regex `i` sobre `name`.
 */
export function buildBrandSearchFilter(term: string): Record<string, unknown> | null {
  const tokens = splitSearchTokens(term);
  if (!tokens) return null;

  return {
    $or: [
      ...tokens.map(({ normalized }) => ({ searchName: buildTokenRegex(normalized) })),
      ...tokens.map(({ raw }) => ({
        searchName: { $exists: false },
        name: buildLegacySearchRegex(raw),
      })),
    ],
  };
}

/** Filtro de clientes: cada token por prefijo en nombre, código, localidad, provincia o domicilio. */
export function buildClientSearchFilter(term: string): Record<string, unknown> | null {
  return buildTokenSearchFilter(term, CLIENT_SEARCH_FIELDS);
}

interface BrandMatchCollections {
  ids: unknown[];
  names: string[];
}

/**
 * Normaliza las marcas resueltas por `buildBrandSearchFilter`.
 *
 * Acepta documentos `{ _id, name }` (preferido: permite saber qué token cubre
 * la marca) y también ids sueltos para no romper llamadores históricos.
 */
function collectBrandMatches(matches: readonly unknown[]): BrandMatchCollections {
  const ids: unknown[] = [];
  const names: string[] = [];

  for (const match of matches) {
    if (match && typeof match === 'object' && '_id' in match) {
      const brand = match as { _id?: unknown; name?: unknown };
      if (brand._id !== undefined && brand._id !== null) ids.push(brand._id);
      if (brand.name !== undefined && brand.name !== null) names.push(String(brand.name));
      continue;
    }

    if (match !== undefined && match !== null) ids.push(match);
  }

  return { ids, names };
}

/**
 * Filtro de productos.
 *
 * La rama principal exige todos los tokens en `Product.searchTokens`, que
 * incluye code, name y brandName. Para bases aún no migradas se agrega una
 * rama asistida por marca: los tokens que cubre el nombre de la marca se
 * descartan y el resto se exige sobre los campos del producto. Sin nombres de
 * marca (sólo ids) se conserva el comportamiento anterior.
 */
export function buildProductSearchFilter(
  term: string,
  matchingBrands: readonly unknown[] = [],
): Record<string, unknown> | null {
  const tokens = splitSearchTokens(term);
  if (!tokens) return null;

  const filter = buildTokenSearchFilter(term, PRODUCT_SEARCH_FIELDS);
  if (!filter) return null;

  const { ids, names } = collectBrandMatches(matchingBrands);
  if (ids.length === 0) return filter;

  let brandCondition: Record<string, unknown>;
  if (names.length === 0) {
    // Compatibilidad: el llamador sólo pasó ids y no se puede saber qué token
    // corresponde a la marca.
    brandCondition = { brandId: { $in: ids } };
  } else {
    const brandWords = new Set(names.flatMap((name) => tokenizeSearchText(name)));
    const remaining = tokens.filter(
      ({ normalized }) => ![...brandWords].some((word) => word.startsWith(normalized)),
    );
    const brandConditions: Record<string, unknown>[] = [{ brandId: { $in: ids } }];

    if (remaining.length > 0) {
      brandConditions.push({
        $or: [
          {
            searchTokens: {
              $all: remaining.map(({ normalized }) => buildTokenRegex(normalized)),
            },
          },
          {
            searchTokens: { $exists: false },
            $and: buildHistoricalTokenConditions(remaining, PRODUCT_SEARCH_FIELDS),
          },
        ],
      });
    }

    brandCondition = brandConditions.length === 1 ? brandConditions[0] : { $and: brandConditions };
  }

  (filter.$or as Record<string, unknown>[]).unshift(brandCondition);
  return filter;
}
