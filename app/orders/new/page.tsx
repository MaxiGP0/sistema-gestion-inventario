import { Suspense } from 'react';
import { requireRolePage } from '@/lib/auth-page';
import { getBrands, getClientById, getClients, getProducts } from '@/lib/catalog';
import { getOrderForSession } from '@/lib/services/order-read';
import NewOrderClient from '@/components/orders/new/NewOrderClient';
import NewOrderPageSkeleton from './NewOrderPageSkeleton';

/**
 * Alta de pedidos server-first.
 *
 * La sesión, las marcas, los primeros 50 clientes y la primera página de
 * productos se resuelven en el servidor y viajan en el primer HTML. El
 * componente cliente sólo conserva el estado interactivo del formulario, la
 * búsqueda con debounce y la cola offline.
 *
 * `?fromOrder=` y `?clientId=` precargan el formulario desde "Mis pedidos", el
 * detalle del pedido o el catálogo de clientes sin un fetch extra del cliente.
 *
 * `Suspense` es obligatorio con Cache Components: el shell se sirve al instante
 * y los datos de la sesión/catálogo se transmiten en el mismo request.
 */
export default function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <Suspense fallback={<NewOrderPageSkeleton />}>
      <NewOrderContent searchParams={searchParams} />
    </Suspense>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function NewOrderContent({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Misma guarda que el proxy, repetida en la página (defensa en profundidad).
  const session = await requireRolePage(['admin', 'vendedor']);
  const params = await searchParams;
  const fromOrderId = firstParam(params.fromOrder);
  const clientId = firstParam(params.clientId);

  const [brands, clients, products, orderResult, initialClient] = await Promise.all([
    getBrands(),
    getClients({ page: 1, search: '', limit: 50 }),
    getProducts({ page: 1, search: '', limit: 50 }),
    fromOrderId ? getOrderForSession(session, fromOrderId) : Promise.resolve(null),
    clientId ? getClientById(clientId) : Promise.resolve(null),
  ]);

  return (
    <NewOrderClient
      initialBrands={brands}
      initialClients={clients.clients}
      initialProducts={products.products}
      initialProductsTotal={products.total}
      salesperson={session.username}
      userId={session.userId}
      role={session.role}
      // Un fromOrder ajeno/inexistente no se precarga en el servidor; el
      // cliente vuelve a intentar por API y muestra el error correspondiente.
      initialOrder={orderResult?.ok ? orderResult.order : null}
      fromOrderId={fromOrderId}
      initialClient={initialClient}
      initialClientId={clientId}
    />
  );
}
