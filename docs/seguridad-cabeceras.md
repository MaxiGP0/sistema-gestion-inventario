# Cabeceras de seguridad, CSRF por origen y cookie `__Host-`

Este documento registra las decisiones del ítem **P1 — Cabeceras de seguridad,
CSRF por origen y hardening de la cookie**. El código vive en
`lib/security-headers.ts`, `next.config.ts`, `proxy.ts` y `lib/session.ts`.

## 1. Cabeceras globales

`next.config.ts` define `headers()` para todas las rutas:

| Cabecera | Valor |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), browsing-topics=()` |
| `Content-Security-Policy-Report-Only` | CSP descripta abajo |
| `Strict-Transport-Security` | `max-age=31536000` (sólo producción) |

`poweredByHeader: false` ya evitaba exponer `X-Powered-By`.

## 2. CSP en Report-Only

La CSP se envía como `Content-Security-Policy-Report-Only`: el navegador
reporta violaciones pero **no bloquea** todavía. Directivas principales:

- `default-src 'self'`
- `script-src 'self' 'unsafe-inline'` (+ `'unsafe-eval'` en desarrollo)
- `style-src 'self' 'unsafe-inline'`
- `img-src 'self' data: blob: https:` (las imágenes remotas no optimizadas se
  cargan directo desde su host)
- `font-src 'self' data:`
- `connect-src 'self'` (+ `ws: wss:` en desarrollo para el HMR)
- `worker-src 'self' blob:` (service worker `/sw.js`)
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`
- `upgrade-insecure-requests` sólo en producción

### Por qué no nonce todavía

La guía de Next.js 16 incluida en el paquete
(`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`)
explica que un nonce obliga a **renderizado dinámico** en todas las páginas y
que es incompatible con PPR. Este proyecto tiene `cacheComponents: true`, así
que adoptar nonce hoy implicaría perder el shell estático y cambiar el modelo de
render.

La alternativa experimental de Next 16 es SRI (`experimental.sri`), que agrega
`integrity` a los bundles externos pero **no cubre los scripts inline**. El
layout necesita un script inline para aplicar el tema antes del primer paint.

Por eso la primera etapa es Report-Only con `'unsafe-inline'`. Para pasar a
`Content-Security-Policy` enforcing hay dos caminos:

1. Habilitar SRI y mover el script de tema a un archivo externo con hash
   conocido (mantiene páginas estáticas).
2. Desactivar PPR y generar un nonce por request en `proxy.ts`, pasándolo al
   layout y a `<Script nonce>`.

No se agregaron hashes sueltos a `script-src` porque, cuando hay un nonce o un
hash, los navegadores **ignoran `'unsafe-inline'`**; eso bloquearía los scripts
inline que Next inyecta para RSC.

El E2E `e2e/security-headers.spec.ts` verifica que login, SSE, `next/image` y el
script de tema no generen eventos `securitypolicyviolation`.

## 3. CSRF por `Origin` / `Sec-Fetch-Site`

`proxy.ts` intercepta **POST, PUT, PATCH y DELETE sobre `/api/*`** antes de
resolver la sesión:

- Si `Sec-Fetch-Site: cross-site`, responde **403**.
- Si viene `Origin`, debe coincidir con el host efectivo del request
  (`x-forwarded-host`, `Host` o la URL). Se comparan host y puerto.
- `Origin: null`, orígenes malformados o de otro host → **403**.
- Sin `Origin` (curl, jobs internos) se permite; los navegadores mandan
  `Origin` en las mutaciones y/o `Sec-Fetch-Site`.

La respuesta es `{ "error": "Origen no permitido" }` con el `x-request-id`
habitual. El chequeo corre también para `/api/auth/login`, que es público.

## 4. Cookie de sesión en producción

En producción el nombre es **`__Host-sgi_session`**. El prefijo `__Host-`
obliga a:

- `Secure`
- `Path=/`
- sin `Domain`

`sessionCookieOptions()` ya no acepta `Domain`; en producción devuelve
`secure: true`. En desarrollo se mantiene `sgi_session` porque el prefijo
`__Host-` requiere HTTPS y `next dev` puede correr sobre HTTP.

La lectura (`readSessionToken`) prueba primero `__Host-sgi_session` y luego
`sgi_session`. Así, al desplegar, las sesiones emitidas antes del cambio
siguen funcionando hasta vencer (8 h). `clearSessionCookies` borra ambas
variantes en producción.

**Requisito de despliegue:** producción debe servirse por HTTPS. Si se sirve por
HTTP, el navegador descarta la cookie `Secure` y el login no persiste.

## 5. Rate limit del login, endpoints caros y multi-instancia

Hay dos stores de ventana fija en memoria del proceso:

- `lib/login-rate-limit.ts`: intentos fallidos de login por IP y por usuario
  (5 intentos / 15 min), con reset tras un login exitoso.
- `lib/api-rate-limit.ts`: endpoints costosos, siempre con clave por usuario
  autenticado (`consume(key, { limit, windowMs })`).

| Endpoint | Límite | Clave |
| --- | --- | --- |
| `GET /api/orders/export` | 10/min | `orders-export:user:<userId>` |
| `POST /api/catalog/import` | 5/min | `catalog-import:user:<userId>` |
| `GET /api/orders?search=...` | 60/min | `orders-search:user:<userId>` |

Al agotarse la ventana, la ruta responde **429** con `Retry-After` en segundos.
El listado sin búsqueda no consume cupo: ya está acotado por `page`/`limit`.

Ambos stores cuelgan de `globalThis` para sobrevivir al HMR de `next dev`.
**Si el deploy pasa a varias instancias o serverless**, cada proceso tendría su
propio contador y el límite efectivo se multiplicaría por instancia. En ese
caso hay que reemplazar la implementación de `consume` por un adaptador
compartido:

- Redis con TTL por ventana (recomendado por latencia y operación simple), o
- MongoDB (ya es dependencia) con upsert atómico por clave y TTL, aceptando el
  costo de una escritura por solicitud.

La interfaz de `lib/api-rate-limit.ts` está aislada para que el cambio no toque
las rutas. El login puede migrarse al mismo adaptador manteniendo sus funciones
públicas (`isRateLimited`, `recordFailedAttempt`, `resetAttempts`).

## 6. Confianza en cabeceras de proxy

`TRUST_PROXY_HEADERS` vale `false` por defecto. En ese modo `getClientIp`
(`lib/login-rate-limit.ts`) y `resolveClientIp` de SSE (`lib/client-ip.ts`)
**ignoran** `x-forwarded-for` y `x-real-ip`: cualquier cliente puede inventarlas
y usarlas para evadir el rate limit por IP. Se usa una IP desconocida y el
límite por usuario autenticado sigue haciendo el trabajo.

Activar `TRUST_PROXY_HEADERS=true` sólo cuando la app esté detrás de un proxy o
balanceador propio que reescriba esas cabeceras. Con la variable en `true` se
toma el primer salto de `x-forwarded-for` y, si falta, `x-real-ip`.

## 7. Pruebas

- `scripts/test-security.ts`: headers en dev/producción, rechazo 403 por
  `Origin` ajeno y `Sec-Fetch-Site: cross-site`, cookie `__Host-` y lectura de
  la variante legacy.
- `scripts/test-api-hardening.ts`: schemas de listados, fechas inválidas,
  recorte de tokens, `consume`, límites por endpoint y comportamiento de
  `TRUST_PROXY_HEADERS=false` con un `x-forwarded-for` arbitrario.
- `scripts/test-orders-export.ts` y `scripts/test-catalog-import.ts`: la
  solicitud N+1 de export/import responde 429 con `Retry-After`.
- `e2e/security-headers.spec.ts`: headers reales servidos por Next, login, SSE,
  `next/image` y tema sin violaciones CSP.
- La suite E2E existente (`orders-flow`, `catalog`) sigue cubriendo el flujo
  operativo completo.
