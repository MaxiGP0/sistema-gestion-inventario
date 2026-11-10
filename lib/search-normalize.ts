/**
 * Normalización compartida por los buscadores de clientes, productos, marcas y
 * pedidos.
 *
 * Los campos `search*` guardan el texto en minúsculas, sin acentos y con los
 * espacios colapsados. `searchTokens` guarda, además, las palabras únicas de
 * esos campos en un array multikey: permite exigir que todos los tokens de una
 * consulta coincidan por prefijo aunque estén en cualquier posición del texto.
 * Así "ahorro" o "super ahorro" encuentran "Supermercado El Ahorro",
 * "shampoo 400" encuentra "Shampoo NovaFarma 400ml" y "biosalud 400" encuentra
 * un producto de BioSalud cuyo nombre no repite la marca.
 *
 * La normalización se aplica tanto al documento como al término buscado, por lo
 * que "GÓMEZ", "gomez" y "Gómez" producen la misma clave.
 */

/** Valor de un campo de búsqueda: texto normalizado o array de tokens. */
export type SearchFieldValue = string | string[];

/** Convierte un valor a la clave de búsqueda: minúsculas, sin acentos y sin espacios extra. */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Separa un texto en tokens normalizados (letras/números), sin repetidos. */
export function tokenizeSearchText(...values: unknown[]): string[] {
  const tokens = values.flatMap((value) =>
    normalizeSearchText(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  return [...new Set(tokens)];
}

export interface ClientSearchFields extends Record<string, SearchFieldValue> {
  searchName: string;
  searchCode: string;
  searchLocalidad: string;
  searchProvince: string;
  searchAddress: string;
  searchTokens: string[];
}

export function buildClientSearchFields(input: {
  code?: unknown;
  name?: unknown;
  address?: unknown;
  localidad?: unknown;
  province?: unknown;
}): ClientSearchFields {
  return {
    searchName: normalizeSearchText(input.name),
    searchCode: normalizeSearchText(input.code),
    searchLocalidad: normalizeSearchText(input.localidad),
    searchProvince: normalizeSearchText(input.province),
    searchAddress: normalizeSearchText(input.address),
    searchTokens: tokenizeSearchText(
      input.code,
      input.name,
      input.address,
      input.localidad,
      input.province,
    ),
  };
}

export interface ProductSearchFields extends Record<string, SearchFieldValue> {
  searchName: string;
  searchCode: string;
  searchTokens: string[];
}

/**
 * Clave de búsqueda de un producto: código, nombre y nombre de marca.
 *
 * El nombre de la marca puede llegar explícito (`brandName`) o embebido en un
 * `brandId` poblado (`{ name }`). Así "biosalud 400" encuentra el producto por el
 * índice multikey aunque el nombre comercial no mencione la marca.
 */
export function buildProductSearchFields(input: {
  code?: unknown;
  name?: unknown;
  brandName?: unknown;
  brandId?: unknown;
}): ProductSearchFields {
  const populatedBrand =
    input.brandId && typeof input.brandId === 'object'
      ? (input.brandId as { name?: unknown }).name
      : undefined;
  const brandName = input.brandName ?? populatedBrand;

  return {
    searchName: normalizeSearchText(input.name),
    searchCode: normalizeSearchText(input.code),
    searchTokens: tokenizeSearchText(input.code, input.name, brandName),
  };
}

export interface OrderSearchItemLike {
  productCode?: unknown;
  productName?: unknown;
  brandName?: unknown;
}

export interface OrderSearchFields extends Record<string, SearchFieldValue> {
  searchTokens: string[];
}

/**
 * Clave de búsqueda de un pedido: cliente, vendedor, código corto y los
 * snapshots de cada línea (`productCode`, `productName` y `brandName`).
 * Permite encontrar un pedido por producto aunque el catálogo haya cambiado.
 */
export function buildOrderSearchFields(input: {
  clientName?: unknown;
  clientCode?: unknown;
  createdBy?: unknown;
  shortId?: unknown;
  items?: readonly unknown[];
}): OrderSearchFields {
  const items = (Array.isArray(input.items) ? input.items : []) as readonly (
    OrderSearchItemLike | null | undefined
  )[];

  return {
    searchTokens: tokenizeSearchText(
      input.clientName,
      input.clientCode,
      input.createdBy,
      input.shortId,
      ...items.flatMap((item) => [item?.productCode, item?.productName, item?.brandName]),
    ),
  };
}

export interface BrandSearchFields extends Record<string, SearchFieldValue> {
  searchName: string;
}

export function buildBrandSearchFields(input: { name?: unknown }): BrandSearchFields {
  return { searchName: normalizeSearchText(input.name) };
}
