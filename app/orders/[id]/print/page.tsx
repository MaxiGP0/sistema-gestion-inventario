import { Suspense } from 'react';
import PrintOrderSheetClient from '@/components/orders/PrintOrderSheetClient';
import { requireRolePage } from '@/lib/auth-page';
import { initialOrderErrorForStatus } from '@/lib/order-initial-data';
import { getOrderForSession } from '@/lib/services/order-read';

/**
 * Hoja de pedido imprimible para el vendedor.
 *
 * `getOrderForSession` aplica la misma política que el detalle y la API: el
 * vendedor sólo puede resolver sus propios pedidos, aunque conozca el id. El
 * cliente de impresión recibe el pedido ya resuelto, sin GET de montaje.
 */
export default function VendorPrintOrderSheetPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-dvh items-center justify-center bg-surface-muted px-4 text-muted"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          Cargando hoja de pedido...
        </div>
      }
    >
      <VendorPrintOrderSheetContent params={params} />
    </Suspense>
  );
}

async function VendorPrintOrderSheetContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'vendedor']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);

  return (
    <PrintOrderSheetClient
      orderId={id}
      initialOrder={result.ok ? result.order : null}
      initialError={result.ok ? null : initialOrderErrorForStatus(result.status)}
      backHref={`/orders/${id}`}
      defaultMode={result.ok && result.order.status === 'borrador' ? 'requested' : 'verified'}
    />
  );
}
