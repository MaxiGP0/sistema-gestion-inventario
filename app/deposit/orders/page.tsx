import type { Metadata } from 'next';
import { Suspense } from 'react';
import OrdersTray from '@/components/OrdersTray';
import OrdersTraySkeleton from '@/components/orders/OrdersTraySkeleton';
import { requireCurrentRolePage } from '@/lib/auth-page';
import {
  getOrdersTrayStatusParam,
  ORDERS_TRAY_CONFIGS,
  resolveOrdersTrayDateRange,
  resolveOrdersTrayInitialFilters,
} from '@/lib/orders-tray';
import { buildOrderListPage, DEFAULT_ORDER_PAGE_SIZE } from '@/lib/services/order-read';

export const metadata: Metadata = {
  title: 'Bandeja de depósito',
};

interface DepositOrdersPageProps {
  searchParams: Promise<{
    status?: string | string[];
    date?: string | string[];
    archived?: string | string[];
    search?: string | string[];
  }>;
}

/**
 * Bandeja de depósito server-first: la primera página de pedidos pendientes se
 * renderiza en el mismo request que la sesión. `?status=` (por ejemplo desde el
 * panel operativo) define el chip inicial y el filtro de la primera página.
 */
export default function DepositOrdersPage({ searchParams }: DepositOrdersPageProps) {
  return (
    <Suspense fallback={<OrdersTraySkeleton variant="deposit" />}>
      <DepositOrdersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function DepositOrdersContent({ searchParams }: DepositOrdersPageProps) {
  const session = await requireCurrentRolePage(['admin', 'controlador']);
  const config = ORDERS_TRAY_CONFIGS.deposit;
  const params = await searchParams;
  const filters = resolveOrdersTrayInitialFilters(config, params);
  const dateRange = resolveOrdersTrayDateRange(filters.datePreset);

  const page = await buildOrderListPage(
    session,
    {
      status: getOrdersTrayStatusParam(config, filters.status),
      archived: filters.showArchived ? 'true' : 'false',
      search: filters.search || null,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
    null,
    DEFAULT_ORDER_PAGE_SIZE,
  );

  if (!page.ok) throw new Error(page.error);
  if (page.mode !== 'cursor') throw new Error('Modo de paginación inesperado');

  return (
    <OrdersTray
      key={`${filters.status}:${filters.datePreset}:${filters.showArchived ? 'archived' : 'active'}`}
      variant="deposit"
      role={session.role}
      username={session.username}
      initialStatus={filters.status}
      initialDatePreset={filters.datePreset}
      initialShowArchived={filters.showArchived}
      initialSearch={filters.search}
      initialOrders={page.orders}
      initialTotal={page.pagination.total ?? null}
      initialNextCursor={page.pagination.nextCursor}
      initialFetchedAt={page.fetchedAt}
    />
  );
}
