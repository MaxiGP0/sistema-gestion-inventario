import { Suspense } from 'react';
import OrderDetailSkeleton from '@/components/orders/OrderDetailSkeleton';
import { requireRolePage } from '@/lib/auth-page';
import { initialOrderErrorForStatus } from '@/lib/order-initial-data';
import { getOrderForSession } from '@/lib/services/order-read';
import DepositOrderVerifyClient from './DepositOrderVerifyClient';

/**
 * Detalle de depósito server-first.
 *
 * El pedido (con cliente, productos y marcas) se resuelve antes de pintar y se
 * pasa como data inicial. El cliente no muestra spinner si ya hay datos.
 */
export default function DepositOrderPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<OrderDetailSkeleton variant="deposit" />}>
      <DepositOrderContent params={params} />
    </Suspense>
  );
}

async function DepositOrderContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'controlador']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);
  const fetchedAt = result.ok ? result.fetchedAt : undefined;

  return (
    <DepositOrderVerifyClient
      orderId={id}
      userId={session.userId}
      role={session.role}
      username={session.username}
      initialOrder={result.ok ? result.order : null}
      initialError={result.ok ? null : initialOrderErrorForStatus(result.status)}
      initialFetchedAt={fetchedAt}
    />
  );
}
