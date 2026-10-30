import { Suspense } from 'react';
import OrderDetailSkeleton from '@/components/orders/OrderDetailSkeleton';
import { requireRolePage } from '@/lib/auth-page';
import { initialOrderErrorForStatus } from '@/lib/order-initial-data';
import { getOrderForSession } from '@/lib/services/order-read';
import BillingOrderClient from './BillingOrderClient';

/**
 * Detalle de facturación server-first: el pedido completo se lee con la misma
 * proyección y permisos que GET /api/orders/[id] antes del primer render.
 */
export default function BillingOrderPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<OrderDetailSkeleton variant="billing" />}>
      <BillingOrderContent params={params} />
    </Suspense>
  );
}

async function BillingOrderContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'billing']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);
  const fetchedAt = result.ok ? result.fetchedAt : undefined;

  return (
    <BillingOrderClient
      orderId={id}
      role={session.role}
      username={session.username}
      initialOrder={result.ok ? result.order : null}
      initialError={result.ok ? null : initialOrderErrorForStatus(result.status)}
      initialFetchedAt={fetchedAt}
    />
  );
}
