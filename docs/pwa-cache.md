# Política de caché del service worker (PWA)

Este documento describe qué guarda el service worker (`public/sw.js`), qué
nunca guarda y cómo se actualiza en producción.

## Versión de las cachés

Las cachés se nombran con el build id:

- `sgi-static-<buildId>`: estáticos y shell offline.
- `sgi-catalog-<buildId>`: respuestas de catálogo.
- `sgi-page-<buildId>`: el HTML de `/orders/new`, `/catalog` y
  `/catalog/clients` para el arranque en frío (ver `docs/catalogo-offline.md`).
  Se borra en logout/cambio de usuario.

El build id se resuelve en `next.config.ts`:

1. `NEXT_PUBLIC_BUILD_ID`, si está definido (recomendado en CI/CD).
2. `GITHUB_SHA` o `VERCEL_GIT_COMMIT_SHA`, recortado a 12 caracteres.
3. Un id local por proceso de build/dev (`dev-...`).

El cliente registra `/sw.js?v=<buildId>` (`components/ServiceWorkerManager.tsx`).
Al cambiar el build id cambia la URL de registro, se instala un SW nuevo y, al
activarse, `activate` borra las cachés que no corresponden a esa versión. El
`sw.js` se sirve con `Cache-Control: no-cache` y se registra con
`updateViaCache: 'none'` para que el navegador no lo tome de su caché HTTP.

## Qué se precachea

Sólo estáticos:

- `/offline` (shell HTML sin sesión ni datos de negocio).
- `/manifest.webmanifest`.
- Los íconos de `public/icons/`.

Los chunks, CSS y fuentes de Next (`/_next/static/**`) se cachean **on demand**
con cache-first porque sus nombres llevan hash. No se precachea ninguna página
de la aplicación.

## Navegaciones

Todas las navegaciones son **network-first con timeout de 4 s**.

- La respuesta de la red se devuelve tal cual.
- **Excepción:** `/orders/new`, `/catalog` y `/catalog/clients` se guardan en
  `sgi-page-<buildId>` después de una visita online. Son las rutas capaces de
  rehidratar sus datos desde IndexedDB; el logout borra la caché. Se comprueba
  la URL final (no cachear un redirect al login) y el `Content-Type:
  text/html`. Las claves son el pathname canónico, sin query.
- Si la red falla o vence el timeout:
  - Las rutas de la allowlist reciben su HTML cacheado si existe; si nunca se
    visitaron online, reciben el shell `/offline`.
  - El resto de las rutas recibe el shell `/offline`, que conserva la URL
    original y tiene un botón **Reintentar**. Nunca se devuelve el HTML
    cacheado de otra ruta.
- Los payloads RSC de navegación cliente (`?_rsc=`, header `RSC` o
  `Accept: text/x-component`) van siempre a la red y no se cachean.
- La hoja de control `/print` queda fuera del SW: el proxy valida el rol antes
  de responder y una copia cacheada podría saltear esa validación.

Esto cubre panel, backoffice, bandejas de depósito/facturación y detalles: las
únicas rutas con datos de negocio que pueden salir de Cache Storage son el alta
y los dos catálogos, y sólo para el mismo navegador/sesión hasta el logout.

## API

Sólo se cachean dos endpoints de catálogo:

- `/api/products` (y subrutas de catálogo).
- `/api/brands`.

La estrategia es network-first con timeout de 6 s y respaldo en caché. La caché
tiene un tope FIFO de 60 entradas y sólo guarda respuestas `2xx` que no estén
marcadas como `no-store`.

Nunca se cachean:

- `/api/clients` (incluye descuentos que afectan precios).
- `/api/orders` y sus mutaciones.
- `/api/notifications`, `/api/users/notifications` y `/api/events` (SSE).
- `/api/users/push-subscriptions`: las suscripciones push pertenecen a un
  usuario y siempre se leen/escriben contra la red y la sesión actual.
- Cualquier otro endpoint, incluido `/api/auth/*`.

Las respuestas de catálogo son iguales para todos los roles autenticados, pero
la caché se borra al cerrar sesión o cambiar de usuario (ver abajo).

## Actualización de la aplicación

1. El SW nuevo se instala pero **no llama a `skipWaiting()`**.
2. Si ya había un SW controlando la página, el nuevo queda en `waiting`.
3. `ServiceWorkerManager` detecta el worker en espera y muestra el aviso
   **“Nueva versión disponible”** con el botón **Actualizar**.
4. Al aceptar, la página envía `{ type: 'SKIP_WAITING' }` y el SW se activa.
5. `controllerchange` recarga una sola vez todas las pestañas controladas, así
   ninguna queda con chunks/HTML de la versión anterior. En la primera
   instalación no se recarga.

El aviso también aparece si la pestaña se abre cuando ya hay un worker en
`waiting`. La comprobación de actualizaciones se repite al volver a foco (con un
mínimo de 60 s).

## Logout y cambio de usuario

`context/UserContext.tsx` ejecuta `clearUserOfflineData()` al cerrar sesión y
cuando detecta que el usuario autenticado cambió respecto de
`sgi_offline_owner`.

Se limpia:

- Todas las cachés de Cache Storage (`sgi-static-*`, `sgi-catalog-*`,
  `sgi-page-*`).
- La base IndexedDB `sgi-offline-catalog` completa (clientes, marcas,
  productos, recientes y meta; ver `docs/catalogo-offline.md`).
- Todos los borradores `sgi_order_draft:*` del equipo.
- La marca `sgi_offline_owner`.

La cola de pedidos pendientes (`sgi-offline` / `order-queue`) tiene una regla
especial para no perder ventas:

- En un logout normal se intenta sincronizar antes de limpiar. Si quedan
  escrituras pendientes reintentables (sin red o error transitorio), la cola se
  conserva y el mismo usuario la retoma al volver a entrar. Las entradas con
  error permanente se borran siempre para no filtrar datos entre usuarios.
- Si en el equipo inicia sesión **otro** usuario, la cola se vacía antes de
  escribir la nueva identidad. Reenviar pedidos de otra sesión violaría la
  autoría y podría duplicar datos.

Tras limpiar, el SW vuelve a precachear el shell estático (sin datos) y en la
próxima navegación online lo repone si el logout ocurrió sin conexión.

## Pruebas

- `scripts/test-pwa-sw.ts`: verifica la política del SW a nivel de fuente
  (precache acotado, allowlist de páginas cacheables, endpoints permitidos, sin
  `skipWaiting` incondicional y limpieza al logout).
- `scripts/test-offline-catalog.ts`: formato de IndexedDB, TTL, aislamiento por
  usuario, recientes y limpieza (con `fake-indexeddb`).
- `e2e/offline-catalog.spec.ts` (proyecto Playwright `pwa`): IndexedDB sembrada,
  recarga de `/orders/new` sin red, alta encolada y limpieza por logout.
- `e2e/pwa.spec.ts` (proyecto Playwright `pwa`, con service workers
  habilitados): primera carga, precache acotado y una página sensible que no se
  sirve desde caché.
