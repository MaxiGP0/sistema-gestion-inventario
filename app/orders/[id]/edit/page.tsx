import { Suspense } from 'react';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import NewOrderClient from '@/components/orders/new/NewOrderClient';
import NewOrderPageSkeleton from '@/app/orders/new/NewOrderPageSkeleton';
import { requireRolePage } from '@/lib/auth-page';
import { getBrands, getClients, getProducts } from '@/lib/catalog';
import { getOrderForSession } from '@/lib/services/order-read';
import { DRAFT_EDIT_BLOCKED_ERROR, isDraftOrderIntact } from '@/lib/services/orders';

/**
 * Edición de un borrador propio reutilizando el formulario del alta.
 *
 * La autorización de lectura ya limita al vendedor a sus pedidos. Sólo se
 * renderiza el formulario si el pedido sigue en `borrador` y depósito no tocó
 * ninguna línea; en caso contrario se explica el conflicto y se vuelve al
 * detalle (la API además responde 409 con la misma regla).
 */
export default function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<NewOrderPageSkeleton />}>
      <EditOrderContent params={params} />
    </Suspense>
  );
}

async function EditOrderContent({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRolePage(['admin', 'vendedor']);
  const { id } = await params;
  const result = await getOrderForSession(session, id);

  if (!result.ok) {
    return (
      <EditOrderUnavailable
        orderId={id}
        message={
          result.status === 403
            ? 'No tenés permiso para editar este pedido.'
            : result.error || 'Pedido no encontrado.'
        }
      />
    );
  }

  if (!isDraftOrderIntact(result.order)) {
    return <EditOrderUnavailable orderId={id} message={DRAFT_EDIT_BLOCKED_ERROR} />;
  }

  const [brands, clients, products] = await Promise.all([
    getBrands(),
    getClients({ page: 1, search: '', limit: 50 }),
    getProducts({ page: 1, search: '', limit: 50 }),
  ]);

  return (
    <NewOrderClient
      mode="edit"
      initialOrder={result.order}
      initialBrands={brands}
      initialClients={clients.clients}
      initialProducts={products.products}
      initialProductsTotal={products.total}
      salesperson={session.username}
      userId={session.userId}
      role={session.role}
      backHref={`/orders/${id}`}
    />
  );
}

function EditOrderUnavailable({ orderId, message }: { orderId: string; message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground transition-colors">
      <Card className="w-full max-w-lg text-center">
        <h1 className="text-base font-semibold">No se puede editar el pedido</h1>
        <p className="mt-2 text-sm text-muted">{message}</p>
        <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
          <Link
            href={`/orders/${orderId}`}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-action px-4 py-2 text-sm font-semibold text-action-fg transition-colors hover:bg-action-hover"
          >
            Volver al pedido
          </Link>
          <Link
            href="/orders"
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-action-text transition-colors hover:bg-action-soft"
          >
            Ir a Mis Pedidos
          </Link>
        </div>
      </Card>
    </div>
  );
}
