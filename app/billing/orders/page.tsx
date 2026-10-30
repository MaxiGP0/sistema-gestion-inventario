import type { Metadata } from 'next';
import { Suspense } from 'react';
import OrdersTray from '@/components/OrdersTray';
import OrdersTraySkeleton from '@/components/orders/OrdersTraySkeleton';
import { requireRolePage } from '@/lib/auth-page';
import {
  getOrdersTrayStatusParam,
  ORDERS_TRAY_CONFIGS,
  resolveOrdersTrayDateRange,
  resolveOrdersTrayInitialFilters,
} from '@/lib/orders-tray';
import { buildOrderListPage, DEFAULT_ORDER_PAGE_SIZE } from '@/lib/services/order-read';

export const metadata: Metadata = {
  title: 'Bandeja de facturación',
};

interface BillingOrdersPageProps {
  searchParams: Promise<{
    status?: string | string[];
    date?: string | string[];
    archived?: string | string[];
  }>;
}

/**
 * Bandeja de facturación server-first: la primera página se resuelve con la
 * sesión del rol y llega pintada en el HTML inicial. `?status=` define el chip
 * inicial y el filtro de la primera página.
 */
export default function BillingOrdersPage({ searchParams }: BillingOrdersPageProps) {
  return (
    <Suspense fallback={<OrdersTraySkeleton variant="billing" />}>
      <BillingOrdersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function BillingOrdersContent({ searchParams }: BillingOrdersPageProps) {
  const session = await requireRolePage(['admin', 'billing']);
  const config = ORDERS_TRAY_CONFIGS.billing;
  const params = await searchParams;
  const filters = resolveOrdersTrayInitialFilters(config, params);
  const dateRange = resolveOrdersTrayDateRange(filters.datePreset);

  const page = await buildOrderListPage(
    session,
    {
      status: getOrdersTrayStatusParam(config, filters.status),
      archived: filters.showArchived ? 'true' : 'false',
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
      variant="billing"
      role={session.role}
      username={session.username}
      initialStatus={filters.status}
      initialDatePreset={filters.datePreset}
      initialShowArchived={filters.showArchived}
      initialOrders={page.orders}
      initialTotal={page.pagination.total ?? null}
      initialNextCursor={page.pagination.nextCursor}
      initialFetchedAt={page.fetchedAt}
    />
  );
}
