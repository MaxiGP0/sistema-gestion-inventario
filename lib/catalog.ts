import { cacheLife, cacheTag } from 'next/cache';
import dbConnect from '@/lib/mongodb';
import {
  buildBrandSearchFilter,
  buildClientSearchFilter,
  buildProductSearchFilter,
} from '@/lib/search-query';
import { Brand } from '@/models/Brand';
import { Client } from '@/models/Client';
import { Product } from '@/models/Product';
import { CATALOG_REVALIDATE_SECONDS, CATALOG_TAGS } from '@/lib/catalog-cache';
import { CLIENTS_PAGE_SIZE, PRODUCTS_PAGE_SIZE } from './catalog-pagination';
import type {
  BrandDTO,
  ClientDTO,
  ClientListResult,
  ProductDTO,
  ProductListResult,
} from '@/lib/types';

export { CLIENTS_PAGE_SIZE, PRODUCTS_PAGE_SIZE } from './catalog-pagination';

const MAX_PAGE_SIZE = 200;

/**
 * Perfil equivalente al `revalidate: 60` que tenía `unstable_cache`: refresco
 * en segundo plano a los 60 s, cliente con la misma ventana y un tope duro
 * para no conservar entradas indefinidamente si el sitio queda sin tráfico.
 */
const CATALOG_CACHE_LIFE = {
  stale: CATALOG_REVALIDATE_SECONDS,
  revalidate: CATALOG_REVALIDATE_SECONDS,
  expire: CATALOG_REVALIDATE_SECONDS * 5,
};

export interface ProductListParams {
  page: number;
  search?: string;
  /** Restringe el listado a una marca puntual (filtro del catálogo móvil). */
  brandId?: string;
  limit?: number;
}

export interface ClientListParams {
  page: number;
  search?: string;
  limit?: number;
}

interface LeanBrand {
  _id: unknown;
  name: string;
  codePrefix?: string;
}

interface LeanProduct {
  _id: unknown;
  brandId?: { _id?: unknown; name?: string } | null;
  code: string;
  name: string;
  imageUrl?: string;
  price?: number;
  priceWithIva?: number;
}

interface LeanClient {
  _id: unknown;
  code: string;
  name: string;
  address?: string;
  localidad?: string;
  province?: string;
  generalDiscount?: number;
  brandDiscounts?: { brandId?: unknown; discountPercentage?: number }[];
}

function normalizePage(page: number): number {
  return Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function normalizeSearch(search: string | undefined): string {
  return (search || '').trim();
}

function toBrandDTO(brand: LeanBrand): BrandDTO {
  return {
    _id: String(brand._id),
    name: brand.name,
    codePrefix: brand.codePrefix ?? '',
  };
}

function toProductDTO(product: LeanProduct): ProductDTO {
  const brand = product.brandId && typeof product.brandId === 'object' ? product.brandId : null;
  const price = Number(product.price) || 0;
  const priceWithIva =
    typeof product.priceWithIva === 'number'
      ? product.priceWithIva
      : Number((price * 1.21).toFixed(2));

  return {
    _id: String(product._id),
    brandId: {
      _id: brand?._id ? String(brand._id) : '',
      name: brand?.name || 'N/A',
    },
    code: product.code,
    name: product.name,
    price,
    priceWithIva,
    imageUrl: product.imageUrl || '',
  };
}

function toClientDTO(client: LeanClient): ClientDTO {
  return {
    _id: String(client._id),
    code: client.code,
    name: client.name,
    address: client.address || '',
    localidad: client.localidad || '',
    province: client.province || '',
    generalDiscount: Number(client.generalDiscount) || 0,
    brandDiscounts: (client.brandDiscounts || []).map((discount) => ({
      brandId: discount.brandId ? String(discount.brandId) : '',
      discountPercentage: Number(discount.discountPercentage) || 0,
    })),
  };
}

/**
 * Marcas del catálogo. Se cachean porque cambian poco y las usan las tres
 * pantallas del backoffice; las mutaciones invalidan `catalog:brands`.
 */
export async function getBrands(): Promise<BrandDTO[]> {
  'use cache';
  cacheTag(CATALOG_TAGS.brands);
  cacheLife(CATALOG_CACHE_LIFE);

  await dbConnect();

  const brands = (await Brand.find({})
    .select('name codePrefix')
    .sort({ name: 1 })
    .lean()) as unknown as LeanBrand[];

  return brands.map(toBrandDTO);
}

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Página de productos para el backoffice y el catálogo. La clave de caché
 * incluye la página, el término de búsqueda y la marca (los argumentos
 * serializados por `use cache`).
 */
export async function getProducts({
  page,
  search,
  brandId,
  limit,
}: ProductListParams): Promise<ProductListResult> {
  'use cache';
  cacheTag(CATALOG_TAGS.products);
  cacheLife(CATALOG_CACHE_LIFE);

  await dbConnect();

  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, PRODUCTS_PAGE_SIZE);
  const normalizedSearch = normalizeSearch(search);
  const normalizedBrandId = (brandId || '').trim();
  const skip = (normalizedPage - 1) * normalizedLimit;

  const query: Record<string, unknown> = { active: { $ne: false } };

  if (normalizedBrandId && OBJECT_ID_REGEX.test(normalizedBrandId)) {
    query.brandId = normalizedBrandId;
  }

  if (normalizedSearch) {
    const brandFilter = buildBrandSearchFilter(normalizedSearch);
    const matchingBrands = brandFilter
      ? ((await Brand.find(brandFilter).select('_id').lean()) as unknown as { _id: unknown }[])
      : [];
    const searchFilter = buildProductSearchFilter(
      normalizedSearch,
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
      .limit(normalizedLimit)
      .lean() as unknown as Promise<LeanProduct[]>,
    Product.countDocuments(query),
  ]);

  return {
    products: products.map(toProductDTO),
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    totalPages: Math.ceil(total / normalizedLimit) || 1,
  };
}

/**
 * Ficha de un cliente puntual para precargar /orders/new?clientId=... con sus
 * descuentos vigentes. Un id inválido o inexistente devuelve `null`.
 */
export async function getClientById(id: string): Promise<ClientDTO | null> {
  'use cache';
  cacheTag(CATALOG_TAGS.clients);
  cacheLife(CATALOG_CACHE_LIFE);

  if (!OBJECT_ID_REGEX.test(id)) return null;

  await dbConnect();

  const client = (await Client.findById(id)
    .select('code name address localidad province generalDiscount brandDiscounts')
    .lean()) as unknown as LeanClient | null;

  return client ? toClientDTO(client) : null;
}

/**
 * Página de clientes del backoffice. Igual que productos, la búsqueda y la
 * página forman parte de la clave de caché.
 */
export async function getClients({
  page,
  search,
  limit,
}: ClientListParams): Promise<ClientListResult> {
  'use cache';
  cacheTag(CATALOG_TAGS.clients);
  cacheLife(CATALOG_CACHE_LIFE);

  await dbConnect();

  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, CLIENTS_PAGE_SIZE);
  const normalizedSearch = normalizeSearch(search);
  const skip = (normalizedPage - 1) * normalizedLimit;

  const query = buildClientSearchFilter(normalizedSearch) ?? {};

  // Proyección explícita: los DTO sólo exponen estos campos y el listado no
  // necesita createdAt/updatedAt/__v.
  const [clients, total] = await Promise.all([
    Client.find(query)
      .select('code name address localidad province generalDiscount brandDiscounts')
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(normalizedLimit)
      .lean() as unknown as Promise<LeanClient[]>,
    Client.countDocuments(query),
  ]);

  return {
    clients: clients.map(toClientDTO),
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    totalPages: Math.ceil(total / normalizedLimit) || 1,
  };
}
