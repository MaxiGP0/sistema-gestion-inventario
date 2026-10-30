import { Suspense } from 'react';
import OrderDetailSkeleton from '@/components/orders/OrderDetailSkeleton';
import VendorOrderDetail from '@/components/orders/VendorOrderDetail';
import { requireRolePage } from '@/lib/auth-page';
import { initialOrderErrorForStatus } from '@/lib/order-initial-data';
import { getOrderForSession } from '@/lib/services/order-read';

/** Detalle de "Mis pedidos" server-first, con la misma política canReadOrder. */
export default function MyOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<OrderDetailSkeleton variant="vendor" />}>
      <MyOrderDetailContent params={params} />
    </Suspense>
  );
}

async function MyOrderDetailContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'vendedor']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);

  return (
    <VendorOrderDetail
      orderId={id}
      role={session.role}
      username={session.username}
      initialOrder={result.ok ? result.order : null}
      initialError={result.ok ? null : initialOrderErrorForStatus(result.status)}
      initialFetchedAt={result.ok ? result.fetchedAt : undefined}
    />
  );
}
