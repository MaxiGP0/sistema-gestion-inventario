import type { Metadata } from 'next';
import { Suspense } from 'react';
import BackofficePageSkeleton from '@/components/BackofficePageSkeleton';
import { requireAdminPage } from '@/lib/auth-page';
import { CLIENTS_PAGE_SIZE, getBrands, getClients } from '@/lib/catalog';
import ClientsManager from './ClientsManager';

export const metadata: Metadata = {
  title: 'Clientes',
};

interface ClientsPageProps {
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

export default function ClientsBackofficePage({ searchParams }: ClientsPageProps) {
  return (
    <Suspense fallback={<BackofficePageSkeleton />}>
      <ClientsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ClientsContent({ searchParams }: ClientsPageProps) {
  await requireAdminPage();

  const params = await searchParams;
  const search = firstParam(params.search).trim();
  const page = parsePage(firstParam(params.page));

  const [brands, result] = await Promise.all([
    getBrands(),
    getClients({ page, search, limit: CLIENTS_PAGE_SIZE }),
  ]);

  return (
    <ClientsManager
      initialClients={result.clients}
      brands={brands}
      initialSearch={search}
      page={result.page}
      total={result.total}
      totalPages={result.totalPages}
    />
  );
}
