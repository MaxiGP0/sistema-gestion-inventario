import type { Metadata } from 'next';
import { Suspense } from 'react';
import BackofficePageSkeleton from '@/components/BackofficePageSkeleton';
import { requireAdminPage } from '@/lib/auth-page';
import { PRODUCTS_PAGE_SIZE, getBrands, getProducts } from '@/lib/catalog';
import ProductsManager from './ProductsManager';

export const metadata: Metadata = {
  title: 'Productos',
};

interface ProductsPageProps {
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

export default function ProductsBackofficePage({ searchParams }: ProductsPageProps) {
  return (
    <Suspense fallback={<BackofficePageSkeleton />}>
      <ProductsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProductsContent({ searchParams }: ProductsPageProps) {
  await requireAdminPage();

  const params = await searchParams;
  const search = firstParam(params.search).trim();
  const brandId = firstParam(params.brandId).trim();
  const page = parsePage(firstParam(params.page));

  const [brands, result] = await Promise.all([
    getBrands(),
    getProducts({ page, search, brandId, limit: PRODUCTS_PAGE_SIZE }),
  ]);

  return (
    <ProductsManager
      initialProducts={result.products}
      brands={brands}
      initialSearch={search}
      initialBrandId={brandId}
      page={result.page}
      total={result.total}
      totalPages={result.totalPages}
    />
  );
}
