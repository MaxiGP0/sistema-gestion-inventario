# Catálogo offline y alta de pedidos en frío

> Implementado el 24/10/2026. Extiende la cola offline de escrituras
> (`docs/idempotencia-alta-pedidos.md`) con un snapshot de lectura para que el
> vendedor pueda abrir `/orders/new` sin señal después de haber visitado la app.

## Objetivo

Antes, clientes y productos vivían sólo en memoria: al cerrar o recargar la app
sin red el alta quedaba vacía y no se podía cargar un pedido. Ahora el catálogo
se guarda en IndexedDB, separado de la cola de escrituras, y se hidrata antes de
revalidar contra el servidor.

La cola de escrituras sigue siendo la única dueña de los pedidos pendientes. El
catálogo offline es sólo una copia de lectura; nunca reemplaza la validación del
servidor.

## Formato de IndexedDB (`sgi-offline-catalog`, versión 1)

Base: `lib/offline-catalog.ts`.

| Store | Contenido | Clave primaria | Índices |
| --- | --- | --- | --- |
| `clients` | Fichas de cliente con descuentos | `key = userId:_id` | `userId` |
| `brands` | Marcas | `key = userId:_id` | `userId` |
| `products` | Productos vistos o precargados | `key = userId:_id` | `userId` |
| `recentClients` | Clientes usados por el usuario | `key = userId:clientId` | `userId`, `lastUsedAt` |
| `meta` | Última sincronización por dataset | `key = userId:dataset` | `userId`, `dataset` |

Cada registro de catálogo tiene esta forma:

```ts
{
  key: 'user-id:client-id', // `${userId}:${_id}`
  userId: 'user-id',
  id: 'client-id',
  savedAt: 1760000000000,
  data: { _id: 'client-id', code: 'CLI-1', name: 'Farmacia…', … }
}
```

`recentClients` agrega `lastUsedAt` y `useCount` para ordenar por frecuencia y
desempatar por uso más reciente. `meta` guarda `{ userId, dataset, savedAt,
count, fullSyncAt? }`: `fullSyncAt` sólo se renueva cuando el prefetch paginado
completa el dataset (hasta el tope configurado). Las escrituras parciales
—primeros 50 registros del SSR o resultados de búsquedas— actualizan `savedAt`
pero preservan ese sello.

La clave incluye el `userId`: aunque dos usuarios compartan el navegador, una
consulta de `user-b` nunca devuelve registros de `user-a`. La limpieza de logout
es una segunda barrera, no la única.

## TTL y límites

| Dataset | TTL por defecto | Tope por defecto |
| --- | --- | --- |
| Clientes | 7 días | 500 |
| Productos | 7 días | 500 |
| Marcas | 30 días | 500 |
| Recientes | 7 días (TTL de clientes) | 5 |

Los valores viven en `OFFLINE_CATALOG_DEFAULT_TTL_MS` y
`OFFLINE_CATALOG_DEFAULT_LIMITS`. Cada función acepta una configuración
efectiva creada con `buildOfflineCatalogConfig({ ttlMs, limits })`, así se
pueden ajustar TTL y topes sin tocar la lógica.

Al leer, los registros vencidos se ignoran y el snapshot queda `fresh: false`.
La UI revalida en red al montar y al recuperar conexión, así que los datos
vencidos se reemplazan en cuanto hay señal; sin conexión no se muestran y el
badge queda visible si hay cualquier copia local en uso.

La escritura hace merge por `_id` y conserva los registros más recientes hasta
el tope. Así una búsqueda no borra el resto del snapshot y la base no crece sin
control.

## Hidratación y revalidación

### `/orders/new`

`components/orders/new/NewOrderClient.tsx`:

1. Al montar guarda en IndexedDB el snapshot que vino en el HTML del servidor
   (primeros 50 clientes, marcas y `userId` de la sesión).
2. Lee clientes, marcas y recientes de IndexedDB.
3. Sin red (`navigator.onLine === false`) usa esa copia y muestra el badge
   **“Datos guardados; pueden estar desactualizados”**.
4. Con red revalida clientes/marcas en segundo plano (`force: true`) sólo si el
   HTML no traía ambos datasets (shell offline); si ya vinieron del Server
   Component no repite esos GET al montar. La revalidación por foco y el evento
   `online` siguen activos.
5. Tras la primera pintura precarga hasta 500 productos
   (`prefetchOfflineCatalogProducts`) y 500 clientes
   (`prefetchOfflineCatalogClients`) si no hay una sincronización completa
   vigente. El TTL evita repetirlo en cada visita y la primera página del SSR ya
   no bloquea la descarga del resto.
6. Cada búsqueda online agrega sus resultados al snapshot; cada búsqueda sin red
   se resuelve localmente por nombre/código con `searchOfflineCatalogClients` y
   `searchOfflineCatalogProducts`.

`hooks/useOrderCatalog.ts` implementa el mismo fallback para productos: si no
hay red o el `fetch` falla, busca en IndexedDB y expone `catalogFromCache` para
el badge. Los productos del carrito de un borrador también se recuperan de la
copia local.

### `/catalog` y `/catalog/clients`

`app/catalog/CatalogBrowser.tsx` y `app/catalog/clients/ClientsBrowser.tsx`:

1. Al montar con datos del servidor escriben productos/clientes y marcas en el
   snapshot (`rememberOfflineCatalogProducts/Clients/Brands`). Visitar el
   catálogo también deja listo el modo offline.
2. Después de la primera pintura completan productos y clientes hasta sus
   topes (500) con `prefetchOfflineCatalogProducts/Clients`, sin bloquear la
   navegación y una sola vez por TTL.
3. Si `navigator.onLine` es `false` (o una comprobación liviana de red falla),
   activan el modo local y muestran el badge **“Datos guardados; pueden estar
   desactualizados”**.
4. La búsqueda, el filtro por marca y la paginación se resuelven con
   `searchOfflineCatalogProducts` / `searchOfflineCatalogClients`, usando los
   mismos tamaños de página que el servidor (`lib/catalog-pagination.ts`).
5. La URL actual manda sobre el HTML cacheado: al recargar sin red se toman
   `search`, `brandId` y `page` de `window.location`, no de los props viejos.
6. En `/catalog/clients`, vendedores y admins tienen el botón **Crear pedido**,
   que abre `/orders/new?clientId=…`. Sin red se usa una navegación completa
   para que el SW sirva el HTML cacheado del alta.

### Modal “Agregar Producto” de depósito

`app/deposit/orders/[id]/DepositOrderVerifyClient.tsx` recibe el `userId` de la
sesión server-side. Al abrir el modal y en cada búsqueda:

1. hidrata resultados desde IndexedDB y los muestra al instante;
2. si hay red, revalida contra `/api/products` y reemplaza la lista;
3. si no hay red o el fetch falla, conserva la copia local con el badge.

### Búsqueda local

Se normalizan mayúsculas y acentos con `lib/search-normalize.ts`. Clientes se
buscan por código, nombre, dirección y localidad; productos por código, nombre y
marca. Todos los tokens del término deben aparecer. Los resultados que empiezan
por el término van primero.

## Clientes recientes/frecuentes

`recordOfflineRecentClient` se llama al elegir un cliente. Incrementa
`useCount`, actualiza `lastUsedAt` y recorta la lista a 5 por usuario. La UI los
muestra arriba del selector (`components/orders/new/RecentClients.tsx`) tanto en
escritorio como en el modal móvil. Al elegir uno, la lista se actualiza en el
acto y se vuelve a persistir.

## Limpieza y aislamiento

- **Logout** (`context/UserContext.tsx`): intenta drenar la cola de pedidos y
  luego `clearUserOfflineData()`.
- **Cambio de usuario**: si `sgi_offline_owner` no coincide con la sesión
  actual, se limpia todo antes de escribir la nueva identidad.
- `clearUserOfflineData()` (`lib/pwa-client.ts`) ejecuta en paralelo:
  - `clearServiceWorkerCaches()`: borra **todas** las cachés de Cache Storage
    (`sgi-static-*`, `sgi-catalog-*`, `sgi-page-*`) y pide al SW que
    reprecachee sólo los estáticos;
  - `deleteOfflineCatalogDatabase()`: cierra la conexión activa y borra
    `sgi-offline-catalog` completa, incluidos todos los stores;
  - borra los borradores `sgi_order_draft:*`;
  - borra la marca `sgi_offline_owner`.
- Si otra pestaña mantiene la base abierta, su handler `versionchange` la cierra
  y el borrado continúa. El logout nunca queda bloqueado por IndexedDB.
- `clearOfflineCatalogForUser(userId)` existe para limpiar un usuario puntual
  sin tocar al resto del equipo (tests y mantenimiento).

Por decisión de producto, un logout normal conserva la **cola de escrituras**
si no se pudo sincronizar para no perder ventas. El catálogo de lectura sí se
borra siempre: no contiene ventas sin enviar y puede quedar viejo.

## Arranque en frío y service worker

`public/sw.js` cachea el HTML de `/orders/new`, `/catalog` y `/catalog/clients`
en `sgi-page-<buildId>` después de una visita online. Las claves son
canónicas (sin query), así una búsqueda no genera entradas duplicadas. Si no hay
red, esas rutas reciben su HTML cacheado en vez del shell genérico; React
hidrata, lee el catálogo desde IndexedDB y permite seguir consultando o cargar
el pedido.

El resto de las páginas sigue la política de `docs/pwa-cache.md`: nunca se sirve
HTML autenticado desde Cache Storage. Las páginas cacheadas se borran en el
logout y al cambiar el build; si todavía no se visitaron online, se devuelve el
shell `/offline` de siempre.

## Pruebas

- `scripts/test-offline-catalog.ts` usa `fake-indexeddb` para verificar formato,
  aislamiento entre usuarios, TTL vencido, búsqueda local, recientes y limpieza.
- `e2e/offline-catalog.spec.ts` (proyecto Playwright `pwa`) siembra IndexedDB,
  recarga `/orders/new` sin red y comprueba que el cliente/producto guardados
  aparecen, que se puede guardar y encolar, que el TTL vencido no se muestra,
  que el modal de “Agregar Producto” de depósito busca localmente y que el
  logout borra la base. También recorre `/catalog` y `/catalog/clients` online,
  pasa a offline, busca productos/clientes locales y crea un pedido con el
  cliente preseleccionado.
- `scripts/test-pwa-sw.ts` valida que el SW sólo cachee la ruta del alta y que
  el logout borre las cachés.
