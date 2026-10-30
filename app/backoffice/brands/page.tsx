import type { Metadata } from 'next';
import { Suspense } from 'react';
import BackofficePageSkeleton from '@/components/BackofficePageSkeleton';
import { requireAdminPage } from '@/lib/auth-page';
import { getBrands } from '@/lib/catalog';
import BrandsManager from './BrandsManager';

export const metadata: Metadata = {
  title: 'Marcas',
};

export default function BrandsBackofficePage() {
  return (
    <Suspense fallback={<BackofficePageSkeleton />}>
      <BrandsContent />
    </Suspense>
  );
}

/**
 * Contenido request-time: la sesión se valida acá y los datos se leen
 * directamente de Mongo (con caché de datos por tag).
 */
async function BrandsContent() {
  await requireAdminPage();
  const brands = await getBrands();

  return <BrandsManager initialBrands={brands} />;
}
