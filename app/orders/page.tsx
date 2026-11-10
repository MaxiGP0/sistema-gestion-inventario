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

interface MyOrdersPageProps {
  searchParams: Promise<{
    status?: string | string[];
    date?: string | string[];
    archived?: string | string[];
    search?: string | string[];
  }>;
}

/**
 * "Mis pedidos": la primera página se resuelve en el servidor con la sesión
 * firmada y viaja en el primer HTML. El filtro por vendedor lo sigue aplicando
 * el servicio compartido, igual que GET /api/orders. `?status=` permite abrir
 * la bandeja ya acotada desde las colas del panel.
 */
export default function MyOrdersPage({ searchParams }: MyOrdersPageProps) {
  return (
    <Suspense fallback={<OrdersTraySkeleton variant="vendor" />}>
      <MyOrdersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function MyOrdersContent({ searchParams }: MyOrdersPageProps) {
  // Revalida el estado actual: una baja o un cambio de rol se aplica acá.
  const session = await requireCurrentRolePage(['admin', 'vendedor']);
  const config = ORDERS_TRAY_CONFIGS.vendor;
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
      variant="vendor"
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
