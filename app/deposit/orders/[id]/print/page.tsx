import { Suspense } from 'react';
import { requireRolePage } from '@/lib/auth-page';
import { initialOrderErrorForStatus } from '@/lib/order-initial-data';
import { getOrderForSession } from '@/lib/services/order-read';
import PrintOrderSheetClient from '@/components/orders/PrintOrderSheetClient';

/**
 * Hoja de control server-first.
 *
 * El pedido se resuelve antes del primer render con la misma política de
 * lectura que `GET /api/orders/[id]`; el cliente de impresión recibe los datos
 * como `initialOrder` y no repite la consulta al hidratar.
 */
export default function PrintOrderSheetPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-dvh items-center justify-center bg-surface-muted px-4 text-muted"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          Cargando hoja de control...
        </div>
      }
    >
      <PrintOrderSheetContent params={params} />
    </Suspense>
  );
}

async function PrintOrderSheetContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'controlador']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);

  return (
    <PrintOrderSheetClient
      orderId={id}
      initialOrder={result.ok ? result.order : null}
      initialError={result.ok ? null : initialOrderErrorForStatus(result.status)}
      backHref={`/deposit/orders/${id}`}
      defaultMode="requested"
    />
  );
}
