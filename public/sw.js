/**
 * Service worker del Sistema de Gestión de Inventario.
 *
 * Política resumida (ver docs/pwa-cache.md):
 * - Las cachés se versionan con el build id que llega en `/sw.js?v=<id>`.
 * - Sólo se precachean estáticos y el shell offline sin datos.
 * - Las navegaciones son network-first con timeout. Sólo se guarda el HTML de
 *   las rutas de la allowlist (`/orders/new`, `/catalog`, `/catalog/clients`):
 *   permiten abrir en frío y rehidratar clientes/productos desde IndexedDB. Se
 *   borran al cerrar sesión o cambiar de usuario junto con el resto de las
 *   cachés. El resto NUNCA se cachea: sin red se devuelve el shell `/offline`.
 * - De la API sólo se cachea catálogo (`/api/products`, `/api/brands`) con un
 *   tope FIFO. Clientes, pedidos, notificaciones y SSE van siempre a la red.
 * - El SW no hace `skipWaiting()` al instalar: la página avisa cuando hay una
 *   versión en espera y el usuario decide cuándo activarla.
 * - Web Push: `push` muestra la notificación del pedido y `notificationclick`
 *   abre la bandeja o el detalle según targetRole/orderId. No cachea nada.
 */

const BUILD_ID = (() => {
  try {
    const value = new URL(self.location.href).searchParams.get('v') || '';
    return value.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'dev';
  } catch {
    return 'dev';
  }
})();

const STATIC_CACHE = `sgi-static-${BUILD_ID}`;
const CATALOG_CACHE = `sgi-catalog-${BUILD_ID}`;
// HTML de las rutas offline para el arranque en frío. Sólo contiene las rutas
// de la allowlist y se limpia en el logout/cambio de usuario (ver
// docs/catalogo-offline.md).
const PAGE_CACHE = `sgi-page-${BUILD_ID}`;

// Cola offline de escrituras de pedidos (ver lib/offline-order-queue.ts). La
// página guarda las altas POST y los PUT de picking fallidos en IndexedDB; al
// recuperar conexión el navegador dispara este tag y el SW avisa a las pestañas
// para que ejecuten el reintento.
const ORDER_PUT_SYNC_TAG = 'sgi-order-put-sync';
const ORDER_PUT_SYNC_MESSAGE = 'SGI_ORDER_PUT_SYNC';

// Mensajes que acepta el SW desde la página.
const SKIP_WAITING_MESSAGE = 'SKIP_WAITING';
const CLEAR_USER_CACHES_MESSAGE = 'CLEAR_USER_CACHES';

// Shell estático sin datos. `/offline` se reescribe a public/offline.html y no
// incluye la sesión ni el payload RSC del usuario.
const OFFLINE_PAGE = '/offline';

// Rutas que pueden abrirse sin red. Su HTML se cachea en `PAGE_CACHE` y los
// datos se hidratan desde IndexedDB. El resto de las rutas cae en el shell
// `/offline`, pero nunca se sirve su propio HTML.
const OFFLINE_ORDER_PAGE = '/orders/new';
const OFFLINE_CATALOG_PAGES = ['/catalog', '/catalog/clients'];
const OFFLINE_NAVIGATION_ALLOWLIST = new Set([OFFLINE_ORDER_PAGE, ...OFFLINE_CATALOG_PAGES]);

// Estáticos mínimos. Las fuentes y chunks de Next se cachean on-demand en
// `/_next/static/**`; no se precachean porque sus nombres llevan hash.
const PRECACHE_URLS = [
  OFFLINE_PAGE,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/shortcut-new-order-192.png',
  '/icons/shortcut-orders-192.png',
  '/icons/shortcut-catalog-192.png',
];

// La caché de catálogo es acotada: búsquedas y páginas generan claves
// distintas y no queremos crecer sin límite.
const MAX_CATALOG_ENTRIES = 60;
// Las páginas se guardan por pathname canónico (sin query), así que el tope es
// el tamaño de la allowlist más algún margen durante una transición de build.
const MAX_PAGE_ENTRIES = 10;

const NAVIGATION_TIMEOUT_MS = 4_000;
const API_TIMEOUT_MS = 6_000;

const CATALOG_API_PATHS = ['/api/products', '/api/brands'];

// Último recurso si el shell offline todavía no se precacheó (por ejemplo, la
// primera instalación ocurrió sin red). No contiene datos de la app.
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sin conexión — Sistema de Gestión de Inventario</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
      main { max-width: 26rem; text-align: center; }
      h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
      p { color: #475569; line-height: 1.5; }
      button { min-height: 3rem; width: 100%; border: 0; border-radius: .75rem; background: #2563eb; color: #fff; font: inherit; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Sin conexión</h1>
      <p>No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.</p>
      <button type="button" onclick="location.reload()">Reintentar</button>
    </main>
  </body>
</html>`;

/** Normaliza `/ruta/` a `/ruta` para comparar contra la allowlist. */
const normalizePathname = (pathname) =>
  pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;

const isCatalogApiRequest = (url) =>
  url.origin === self.location.origin &&
  CATALOG_API_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`));

/**
 * La hoja de control se imprime con datos del pedido y su ruta está protegida
 * por rol en el proxy. No se cachea: una respuesta cacheada se serviría antes
 * de que el proxy pueda redirigir a un usuario sin permiso.
 */
const isRoleProtectedPrintSheet = (url) =>
  url.origin === self.location.origin && url.pathname.endsWith('/print');

/** Assets inmutables de Next (chunks, CSS, fuentes) e íconos del manifest. */
const isStaticAssetRequest = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest');

/**
 * Los payloads RSC de navegación cliente también pueden contener datos de
 * negocio. No se cachean ni se responden desde caché: van siempre a la red.
 */
const isRscRequest = (request, url) =>
  url.searchParams.has('_rsc') ||
  request.headers.get('rsc') === '1' ||
  (request.headers.get('accept') || '').includes('text/x-component');

const isNavigationRequest = (request) =>
  request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');

const fetchWithTimeout = async (request, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

/** Elimina las entradas más viejas si la caché supera el tope. */
const trimCache = async (cache, maxEntries) => {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;

  const excess = keys.length - maxEntries;
  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
};

/** Guarda una respuesta en la caché indicada aplicando el tope FIFO. */
const putInCache = async (cacheName, request, response, maxEntries) => {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  if (maxEntries) await trimCache(cache, maxEntries);
};

/**
 * Precarga sólo estáticos. Se usa `Promise.allSettled` para que un asset que
 * falla (por ejemplo, sin red durante la instalación) no impida activar el SW:
 * el shell tiene además un fallback inline.
 */
const precacheStatic = async () => {
  const cache = await caches.open(STATIC_CACHE);

  await Promise.allSettled(
    PRECACHE_URLS.map(async (url) => {
      try {
        const response = await fetch(
          new Request(url, { cache: 'reload', credentials: 'same-origin' }),
        );
        if (response.ok) await cache.put(url, response);
      } catch {
        // Sin red: el shell inline cubre el arranque offline.
      }
    }),
  );
};

/**
 * Repone el shell offline después de un logout si la caché se borró mientras
 * no había red. No cachea la navegación actual: sólo el HTML estático.
 */
const ensureOfflineShell = async () => {
  try {
    const cache = await caches.open(STATIC_CACHE);
    if (await cache.match(OFFLINE_PAGE)) return;

    const response = await fetch(
      new Request(OFFLINE_PAGE, { cache: 'reload', credentials: 'same-origin' }),
    );
    if (response.ok) await cache.put(OFFLINE_PAGE, response);
  } catch {
    // Sin red: se reintenta en la próxima navegación online.
  }
};

const deleteOldCaches = async () => {
  const keptCaches = new Set([STATIC_CACHE, CATALOG_CACHE, PAGE_CACHE]);
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => !keptCaches.has(cacheName))
      .map((cacheName) => caches.delete(cacheName)),
  );
};

/**
 * Respuesta offline: siempre el shell estático, nunca el HTML de la ruta
 * pedida. Si la ruta está en la allowlist, el shell muestra un mensaje
 * específico (el pathname original se conserva en la barra de direcciones).
 */
const offlineFallback = async (requestUrl) => {
  const url = new URL(requestUrl);
  const pathname = normalizePathname(url.pathname);
  const allowlisted = OFFLINE_NAVIGATION_ALLOWLIST.has(pathname);

  // Alta de pedidos y catálogos: si la página se visitó online, se devuelve su
  // HTML para que React hidrate y lea los datos desde IndexedDB.
  if (allowlisted) {
    const cachedPage = await caches.match(pathname, { cacheName: PAGE_CACHE });
    if (cachedPage) return cachedPage;
  }

  const cached = await caches.match(OFFLINE_PAGE, { cacheName: STATIC_CACHE });

  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('X-SGI-Offline-Route', allowlisted ? 'allowlisted' : 'generic');
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};

/**
 * Guarda el HTML de las rutas de la allowlist para el arranque en frío.
 * Comprueba la URL final para no cachear una redirección al login, y el
 * Content-Type para no guardar respuestas de error ni payloads RSC.
 */
const cacheOfflinePage = async (request, response) => {
  if (!response.ok) return;

  const requestUrl = new URL(request.url);
  const pathname = normalizePathname(requestUrl.pathname);
  if (!OFFLINE_NAVIGATION_ALLOWLIST.has(pathname)) return;

  const finalUrl = new URL(response.url);
  if (normalizePathname(finalUrl.pathname) !== pathname) return;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return;

  const cache = await caches.open(PAGE_CACHE);
  // Clave canónica sin query: el snapshot de IndexedDB resuelve la búsqueda y
  // el fallback siempre busca el pathname, incluso si la URL tenía parámetros.
  await cache.put(new Request(pathname), response);
  await trimCache(cache, MAX_PAGE_ENTRIES);
};

const handleNavigation = async (event) => {
  const { request } = event;

  // Network-first con timeout. Sólo las rutas de la allowlist se guardan; el
  // resto de las páginas puede tener datos de negocio y jamás se sirve desde
  // caché.
  const networkPromise = fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);

  // Repone el shell offline y, cuando corresponde, el HTML de la página.
  // `waitUntil` se llama de forma síncrona para que el navegador mantenga vivo
  // el SW.
  event.waitUntil(
    networkPromise
      .then((response) =>
        Promise.allSettled([cacheOfflinePage(request, response.clone()), ensureOfflineShell()]),
      )
      .catch(() => {
        // Sin red: el HTML cacheado o el shell cubren la respuesta.
      }),
  );

  try {
    return await networkPromise;
  } catch {
    return offlineFallback(request.url);
  }
};

const handleCatalogRequest = async (event) => {
  const { request } = event;
  const networkPromise = fetchWithTimeout(request, API_TIMEOUT_MS);

  event.waitUntil(
    networkPromise
      .then(async (networkResponse) => {
        // Sólo respuestas exitosas y cacheables. Nunca se guarda un 4xx/5xx ni
        // una respuesta marcada como no-store.
        if (
          networkResponse.ok &&
          !(networkResponse.headers.get('cache-control') || '').includes('no-store')
        ) {
          await putInCache(CATALOG_CACHE, request, networkResponse.clone(), MAX_CATALOG_ENTRIES);
        }
      })
      .catch(() => {
        // La respuesta de error se maneja abajo con la caché de respaldo.
      }),
  );

  try {
    return await networkPromise;
  } catch {
    const cachedResponse = await caches.match(request, { cacheName: CATALOG_CACHE });
    return cachedResponse || Response.error();
  }
};

const handleStaticRequest = async (event) => {
  const { request } = event;
  const cachedResponse = await caches.match(request, { cacheName: STATIC_CACHE });
  if (cachedResponse) return cachedResponse;

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Se espera la escritura antes de responder: son assets pequeños y así
      // el SW no se apaga antes de terminar de cachearlos.
      await putInCache(STATIC_CACHE, request, response.clone()).catch(() => {
        // Un asset que no se puede guardar no debe romper la respuesta.
      });
    }
    return response;
  } catch {
    return Response.error();
  }
};

// --- Web Push -------------------------------------------------------------

const PUSH_ICON = '/icons/icon-192.png';

/** Sólo roles conocidos; cualquier otro valor se trata como alerta global. */
const normalizePushTargetRole = (value) => {
  if (value === 'deposit' || value === 'billing' || value === 'vendor') return value;
  return 'all';
};

/** Evita abrir URLs externas o protocol-relative desde el payload. */
const isSafeInternalPath = (value) =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('\\');

/**
 * Destino del clic. El servidor manda `url` ya resuelta; si falta, se repite
 * la regla: detalle de depósito/facturación/vendedor o bandeja; `all` abre el
 * panel.
 */
const resolvePushUrl = (data) => {
  const payload = data && typeof data === 'object' ? data : {};
  if (isSafeInternalPath(payload.url)) return payload.url;

  const role = normalizePushTargetRole(payload.targetRole);
  const orderId =
    typeof payload.orderId === 'string' && payload.orderId.trim()
      ? encodeURIComponent(payload.orderId)
      : '';

  if (role === 'billing') {
    return orderId ? `/billing/orders/${orderId}` : '/billing/orders';
  }
  if (role === 'deposit') {
    return orderId ? `/deposit/orders/${orderId}` : '/deposit/orders';
  }
  if (role === 'vendor') {
    return orderId ? `/orders/${orderId}` : '/orders';
  }
  return '/';
};

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};

      if (event.data) {
        try {
          data = event.data.json();
        } catch {
          // Payload en texto plano: se usa como cuerpo de la notificación.
          try {
            const text = typeof event.data.text === 'function' ? event.data.text() : '';
            data = text ? { body: text } : {};
          } catch {
            data = {};
          }
        }
      }

      const payload = data && typeof data === 'object' ? data : {};
      const title =
        typeof payload.title === 'string' && payload.title.trim()
          ? payload.title
          : 'Sistema de Gestión de Inventario';
      const body = typeof payload.body === 'string' ? payload.body : '';
      const orderId =
        typeof payload.orderId === 'string' && payload.orderId.trim() ? payload.orderId : undefined;
      const options = {
        body,
        icon: PUSH_ICON,
        badge: PUSH_ICON,
        data: {
          url: resolvePushUrl(payload),
          targetRole: normalizePushTargetRole(payload.targetRole),
          ...(orderId ? { orderId } : {}),
        },
        ...(orderId ? { tag: `sgi-order-${orderId}`, renotify: true } : {}),
      };

      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data =
    event.notification.data && typeof event.notification.data === 'object'
      ? event.notification.data
      : {};
  const targetUrl = new URL(resolvePushUrl(data), self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        if (!client.url) continue;

        let clientUrl;
        try {
          clientUrl = new URL(client.url);
        } catch {
          continue;
        }
        if (clientUrl.origin !== self.location.origin) continue;

        let focused = false;
        let navigated = false;

        if ('focus' in client) {
          try {
            await client.focus();
            focused = true;
          } catch {
            // La pestaña pudo haberse cerrado o estar en segundo plano en Firefox móvil.
          }
        }

        if ('navigate' in client) {
          try {
            await client.navigate(targetUrl);
            navigated = true;
          } catch {
            // Si no se puede navegar, al menos queda enfocada o se abre ventana abajo.
          }
        }

        if (focused || navigated) return;
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});

self.addEventListener('install', (event) => {
  // Sin skipWaiting: la nueva versión queda en waiting hasta que el usuario
  // acepta el aviso "Nueva versión disponible".
  event.waitUntil(precacheStatic());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await deleteOldCaches();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === SKIP_WAITING_MESSAGE) {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (data.type === CLEAR_USER_CACHES_MESSAGE) {
    event.waitUntil(
      (async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
        await precacheStatic();
      })(),
    );
  }
});

/**
 * Despierta a las pestañas abiertas para que ellas reintenten la cola de
 * IndexedDB. La página es la única dueña de la cola: así se reutilizan las
 * mismas reglas de conflicto/validación y el indicador se actualiza solo.
 */
const notifyOrderPutSync = async () => {
  const clientList = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  await Promise.all(
    clientList.map((client) => client.postMessage({ type: ORDER_PUT_SYNC_MESSAGE })),
  );
};

self.addEventListener('sync', (event) => {
  if (event.tag !== ORDER_PUT_SYNC_TAG) return;
  event.waitUntil(notifyOrderPutSync());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // El propio SW y los endpoints de autenticación no pasan por caché.
  if (url.pathname === '/sw.js') return;

  // La hoja de control se imprime con datos y está protegida por rol.
  if (isRoleProtectedPrintSheet(url)) return;

  if (url.pathname.startsWith('/api/')) {
    // Pedidos, clientes, notificaciones y SSE: siempre red. Cachearlos hacía
    // que las bandejas mostraran datos viejos o de otra sesión.
    if (!isCatalogApiRequest(url)) return;

    event.respondWith(handleCatalogRequest(event));
    return;
  }

  // Navegaciones cliente de Next: el payload RSC puede tener datos de negocio.
  if (isRscRequest(request, url)) return;

  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (isStaticAssetRequest(url)) {
    event.respondWith(handleStaticRequest(event));
  }
});
