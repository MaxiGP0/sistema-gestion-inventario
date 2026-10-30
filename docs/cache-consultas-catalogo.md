# Caché y cancelación de consultas del catálogo

Este documento resume el comportamiento de las consultas GET que alimentan los
selectores y buscadores del alta de pedidos y de depósito.

## Cliente HTTP (`lib/api-client.ts`)

- `apiRequest`/`api.get` aceptan `signal` (es parte de `RequestInit` y se
  reenvía tal cual a `fetch`).
- Al abortar, la promesa rechaza con un `AbortError`; **no** se envuelve como
  `ApiClientError` de red ni se reporta a Sentry.
- Helpers:
  - `createAbortController()`: crea el controlador.
  - `cancelRequest(controller, reason?)`: aborta una sola vez (idempotente).
  - `isAbortError(error)`: distingue una cancelación de un fallo real.
- `createLatestRequest()` (`lib/latest-request.ts`) implementa la regla "gana
  la última": cada `start()` aborta la consulta anterior y entrega un
  `requestId` + `signal`. `isCurrent(ticket)` usa ambas barreras: el id descarta
  respuestas tardías y la señal descarta respuestas canceladas.

Los hooks y pantallas guardan un coordinador por consulta:

- `useOrderCursorList`: búsqueda/filtros de pedidos.
- `useOrderCatalog`: búsqueda de productos y recuperación de productos del
  carrito.
- `app/orders/new/page.tsx`: búsqueda de clientes.
- `app/deposit/orders/[id]/page.tsx`: búsqueda del modal de productos.

Al cambiar un filtro, cerrar un selector/modal o desmontar, se aborta la
consulta anterior de inmediato (sin esperar al debounce). El `requestId` sigue
siendo la segunda barrera para respuestas que ya estaban en vuelo.

## Caché en memoria (`lib/catalog-query-cache.ts`)

Sólo para los GET de listado:

| Recurso            | TTL    |
| ------------------ | ------ |
| `/api/products`    | 60 s   |
| `/api/brands`      | 60 s   |
| `/api/clients`     | 20 s   |

Clientes usa un TTL más corto porque sus descuentos generales/por marca inciden
en el precio del pedido.

- **Deduplicación**: dos consumidores de la misma URL comparten una única
  promesa en vuelo. Si todos cancelan, se aborta el `fetch` subyacente; si
  queda al menos uno, la consulta continúa.
- **Invalidación al mutar**: `invalidateCatalogCache('products' | 'brands' |
  'clients')` limpia entradas y aborta consultas en curso. Se llama después de
  guardar/eliminar en el backoffice y después de importar catálogo. La
  invalidación del servidor (`revalidateCatalog`, tags de Next) sigue
  existiendo en paralelo.
- **Revalidación al volver a foco**: un único listener de
  `focus`/`visibilitychange` invalida todo el catálogo y avisa a los hooks
  suscriptores, que vuelven a consultar. Hay un cooldown de 1 s para evitar
  duplicados cuando `focus` y `visibilitychange` se disparan juntos.
- `getCatalog` pide con `cache: 'no-cache'` para que, tras invalidar, el
  navegador no reutilice una copia HTTP vieja guardada por `max-age`.

## Cabeceras HTTP

Sólo en los `GET` de catálogo (`app/api/products`, `clients`, `brands`):

- Productos y marcas: `private, max-age=60, stale-while-revalidate=300`.
- Clientes: `private, max-age=30, stale-while-revalidate=120`.

No se modifican pedidos, notificaciones ni SSE.

## Medición

`npm run measure:catalog` simula una red de 40 ms y compara el comportamiento
anterior (sin caché/cancelación) con el actual:

| Escenario                    | Antes                    | Después               |
| ---------------------------- | ------------------------ | --------------------- |
| Abrir/cerrar selector x5     | 5 requests · 255 ms      | 1 request · 47 ms     |
| Misma búsqueda x3            | 3 requests · 139 ms      | 1 request · 47 ms     |
| Tipeo rápido (6 términos)    | 6 respuestas aplicadas   | 1 respuesta aplicada  |

En el tipeo rápido se inician 6 consultas, pero las 5 anteriores se abortan:
sólo se completa y aplica la última.

## Pruebas

- `scripts/test-api-client.ts`: reenvío de `signal`, propagación de
  `AbortError` y helpers de cancelación.
- `scripts/test-catalog-query.ts`: tipeo rápido sin resultados viejos,
  aborto de la consulta anterior, deduplicación, TTL, invalidación, foco y
  cabeceras.
- `scripts/measure-catalog-query.ts`: medición antes/después.
