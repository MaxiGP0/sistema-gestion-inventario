# Alta de pedidos server-first

> Implementado el 24/10/2026 sobre `7cad653`. Reemplaza el alta 100 % cliente
> por un Server Component con isla cliente y datos iniciales en el HTML.

## Arquitectura

- `app/orders/new/page.tsx` es un Server Component:
  - `requireRolePage(['admin', 'vendedor'])` valida la cookie firmada (defensa
    en profundidad respecto del proxy).
  - `getBrands()` y `getClients({ page: 1, search: '', limit: 50 })` de
    `lib/catalog.ts` resuelven marcas y los primeros 50 clientes.
  - El usuario y el vendedor salen de la sesión del servidor: no se leen de
    `localStorage` ni viajan en el body del alta.
  - El árbol dinámico vive dentro de `Suspense`; el skeleton conserva el
    título mientras se transmiten la sesión y el catálogo.
- `components/orders/new/NewOrderClient.tsx` conserva el estado interactivo:
  cantidades, descuentos, borrador, búsqueda con debounce, cola offline y
  guardado. La isla recibe `initialClients`, `initialBrands`, `salesperson` y
  `userId`.
- La lista inicial se usa directamente. Al hidratar se guarda en el catálogo
  offline (IndexedDB) y se revalida una vez en red para mantener ese snapshot
  fresco; la respuesta no bloquea la primera pintura. Al volver a foco se
  refresca con `getCatalog`, igual que la búsqueda vigente si el selector está
  abierto. Ver `docs/catalogo-offline.md`.
- Los subcomponentes separan responsabilidades:
  - `ClientPanel` y `MobileClientPanel` (paneles de cliente),
  - `SelectedClientDetails` (ficha, repetir pedido y descuentos),
  - `OrderSummaryPanel` (totales y guardado),
  - `MobileActionBar` (barra fija móvil),
  - `OfflinePendingBanner` y `RepeatLastOrderPanel`.
- `MobileClientModal` y `MobileCheckoutModal` se importan con `next/dynamic`
  (`ssr: false`) y sólo se montan al abrirlos. Su código y el `Modal`
  compartido no forman parte del bundle inicial.

## Guardado y offline

El borrador (`useOrderDraft`) y la cola IndexedDB (`offline-order-queue`)
siguen iguales; el `userId` que los identifica ahora viene de la sesión
server-side. Al guardar online se muestra el toast y se navega en el mismo
tick con `startTransition`: ya no hay `setTimeout(1500)`. El toast vive en el
layout raíz y sobrevive a la navegación.

## Pruebas

- `e2e/orders-new.spec.ts` verifica que el HTML inicial contiene clientes,
  marcas y vendedor; que al hidratar se revalida una vez cada recurso para
  refrescar el catálogo offline; que controlador y facturación no entran al
  alta; y que vendedor y admin sí.
- El borrador se sigue restaurando sin esperar la sesión (`e2e/session.spec.ts`)
  y la cola offline sigue sincronizando una sola vez
  (`e2e/offline-orders.spec.ts`).
- Como el seed E2E recrea los `_id` de clientes/marcas, `e2e/global-setup.ts`
  limpia `.next/cache` antes de levantar el servidor: evita que
  `unstable_cache` sirva IDs del seed anterior y que el alta falle con
  “Cliente no encontrado”.

## Medición local

Producción (`next start`), Mongo efímero sembrado, Chromium headless,
1440×900. Los valores son de una corrida local y sirven de orden de magnitud,
no como presupuesto de CI.

| Métrica | Antes | Después |
| --- | --- | --- |
| JS inicial de `/orders/new` (gzip) | 215,8 KB | 189,0 KB |
| JS inicial de `/orders/new` (sin comprimir) | 702,8 KB | 606,9 KB |
| Requests de catálogo en la primera pintura | `GET /api/clients` + `GET /api/brands` | 0 (la revalidación posterior no bloquea) |
| TTFB | 13 ms | 9 ms (5 ms con caché tibia) |
| LCP | 104 ms | 424 ms (364 ms con caché tibia) |

La primera pintura pasó a incluir los datos finales del alta. Antes, el LCP de
104 ms correspondía al formulario vacío; clientes y marcas llegaban después de
hidratar, con dos requests adicionales. El LCP actual sigue muy por debajo del
objetivo de 2,5 s para móvil y elimina el waterfall de datos.
