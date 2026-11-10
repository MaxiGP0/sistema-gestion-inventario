import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireCurrentRolePage } from '@/lib/auth-page';
import { PRODUCTS_PAGE_SIZE, getBrands, getProducts } from '@/lib/catalog';
import CatalogBrowser from './CatalogBrowser';
import CatalogPageSkeleton from './CatalogPageSkeleton';

export const metadata: Metadata = {
  title: 'Catálogo',
  description: 'Consulta de productos, marcas y precios del catálogo (solo lectura).',
};

interface CatalogPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function parsePage(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
}

export default function CatalogPage({ searchParams }: CatalogPageProps) {
  return (
    <Suspense fallback={<CatalogPageSkeleton />}>
      <CatalogContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CatalogContent({ searchParams }: CatalogPageProps) {
  const session = await requireCurrentRolePage(['admin', 'vendedor', 'controlador']);

  const params = await searchParams;
  const search = firstParam(params.search).trim();
  const brandId = firstParam(params.brandId).trim();
  const page = parsePage(firstParam(params.page));

  const [brands, result] = await Promise.all([
    getBrands(),
    getProducts({ page, search, brandId, limit: PRODUCTS_PAGE_SIZE }),
  ]);

  return (
    <CatalogBrowser
      initialProducts={result.products}
      brands={brands}
      initialSearch={search}
      initialBrandId={brandId}
      page={result.page}
      total={result.total}
      totalPages={result.totalPages}
      role={session.role}
      username={session.username}
    />
  );
}
