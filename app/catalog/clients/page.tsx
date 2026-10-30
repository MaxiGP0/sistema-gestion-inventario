import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireRolePage } from '@/lib/auth-page';
import { CLIENTS_PAGE_SIZE, getBrands, getClients } from '@/lib/catalog';
import CatalogPageSkeleton from '../CatalogPageSkeleton';
import ClientsBrowser from './ClientsBrowser';

export const metadata: Metadata = {
  title: 'Catálogo de Clientes',
  description: 'Consulta de clientes, direcciones y descuentos del catálogo (solo lectura).',
};

interface CatalogClientsPageProps {
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

export default function CatalogClientsPage({ searchParams }: CatalogClientsPageProps) {
  return (
    <Suspense fallback={<CatalogPageSkeleton />}>
      <CatalogClientsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CatalogClientsContent({ searchParams }: CatalogClientsPageProps) {
  const session = await requireRolePage(['admin', 'vendedor', 'controlador']);

  const params = await searchParams;
  const search = firstParam(params.search).trim();
  const page = parsePage(firstParam(params.page));

  const [brands, result] = await Promise.all([
    getBrands(),
    getClients({ page, search, limit: CLIENTS_PAGE_SIZE }),
  ]);

  return (
    <ClientsBrowser
      initialClients={result.clients}
      brands={brands}
      initialSearch={search}
      page={result.page}
      total={result.total}
      totalPages={result.totalPages}
      role={session.role}
      username={session.username}
    />
  );
}
