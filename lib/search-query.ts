/**
 * Construcción de filtros de búsqueda por tokens.
 *
 * La consulta indexada exige que todos los tokens del término coincidan como
 * prefijo de alguna palabra del array multikey `searchTokens`
 * (`$all: [/^token1/, /^token2/]`). Así "ahorro" encuentra "Supermercado El
 * Ahorro" y "shampoo 400" encuentra "Shampoo Capitalis 400ml", sin importar la
 * posición de las palabras.
 *
 * Los documentos históricos que todavía no tienen `searchTokens` conservan el
 * camino anterior (prefijo sobre los campos `search*` y, si tampoco existen,
 * regex `i` sobre los campos originales) dentro de una rama `$exists: false`.
 * Una vez ejecutado el backfill esa rama no devuelve documentos.
 */

import { escapeRegex } from './escape-regex';
import { normalizeSearchText } from './search-normalize';

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

/** Divide el término en tokens únicos; conserva el original para el fallback. */
export function splitSearchTokens(term: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  const seen = new Set<string>();

  for (const raw of String(term ?? '')
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    const normalized = normalizeSearchText(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push({ raw, normalized });
  }

  return tokens;
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
  if (tokens.length === 0) return null;

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

/** Filtro de marcas para resolver los `brandId` de una búsqueda de productos. */
export function buildBrandSearchFilter(term: string): Record<string, unknown> | null {
  return buildPrefixSearchFilter(term, BRAND_SEARCH_FIELDS);
}

/** Filtro de clientes: cada token por prefijo en nombre, código, localidad, provincia o domicilio. */
export function buildClientSearchFilter(term: string): Record<string, unknown> | null {
  return buildTokenSearchFilter(term, CLIENT_SEARCH_FIELDS);
}

/**
 * Filtro de productos. Las marcas que coinciden por prefijo se resuelven aparte
 * y se agregan como `brandId: { $in: [...] }`, igual que antes, pero sin un
 * regex no anclado sobre `Brand.name`.
 */
export function buildProductSearchFilter(
  term: string,
  matchingBrandIds: readonly unknown[] = [],
): Record<string, unknown> | null {
  const filter = buildTokenSearchFilter(term, PRODUCT_SEARCH_FIELDS);
  if (!filter) return null;

  if (matchingBrandIds.length > 0) {
    (filter.$or as Record<string, unknown>[]).unshift({ brandId: { $in: matchingBrandIds } });
  }

  return filter;
}
