import { Suspense } from 'react';
import PrintOrderSheetClient from '@/components/orders/PrintOrderSheetClient';
import { requireRolePage } from '@/lib/auth-page';
import { initialOrderErrorForStatus } from '@/lib/order-initial-data';
import { getOrderForSession } from '@/lib/services/order-read';

/**
 * Hoja de pedido imprimible para facturación.
 *
 * Se resuelve en el servidor con la misma sesión y política de lectura que el
 * detalle de facturación; el botón "Imprimir / PDF" de ese detalle apunta acá.
 */
export default function BillingPrintOrderSheetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
      <BillingPrintOrderSheetContent params={params} />
    </Suspense>
  );
}

async function BillingPrintOrderSheetContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'billing']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);

  return (
    <PrintOrderSheetClient
      orderId={id}
      initialOrder={result.ok ? result.order : null}
      initialError={result.ok ? null : initialOrderErrorForStatus(result.status)}
      backHref={`/billing/orders/${id}`}
      defaultMode="verified"
    />
  );
}
