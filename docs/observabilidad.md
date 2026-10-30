# Observabilidad: Sentry, métricas, alertas y correlación

Este documento describe la integración de **Sentry (`@sentry/nextjs`)** para
errores de servidor y cliente, las métricas de aplicación, las alertas y las
reglas de privacidad. El objetivo es poder pasar de un síntoma (un 503, un pico
de 5xx, un error de Mongo) a la línea de log y al request original sin exponer
datos personales.

## 1. Arquitectura

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Arranque Node/Edge | `instrumentation.ts` | Valida el entorno, inicializa Sentry y reporta errores no atrapados con `onRequestError`. |
| Config servidor | `sentry.server.config.ts` | `Sentry.init` en Node (runtime real de la app). |
| Config Edge | `sentry.edge.config.ts` | `Sentry.init` si algún tramo corre en Edge. |
| Config browser | `instrumentation-client.ts` | `Sentry.init` antes de la hidratación y breadcrumbs de navegación. |
| Opciones comunes | `lib/observability/sentry-config.ts` | Sampling, redacción, `dataCollection`, tags iniciales. |
| Errores | `lib/observability/errors.ts` | Captura servidor, health, cliente y API; tags de correlación. |
| Métricas | `lib/observability/metrics.ts` | Counters, gauges y distribuciones. |
| Redacción | `lib/observability/redact.ts` | Última barrera para cuerpos, contraseñas, cookies y query strings. |
| Alertas como código | `lib/observability/sentry-alerts.ts` + `scripts/configure-sentry-alerts.ts` | Provisiona monitores y alertas por API. |

Sentry es **opcional en runtime**: si no hay DSN, `Sentry.init` no se ejecuta y
todas las funciones de captura/métricas quedan en no-op. El build, los tests y
la app siguen funcionando.

## 2. Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `SENTRY_DSN` | No | DSN del servidor (Node/Edge). Sin él no se envía nada desde el servidor. |
| `NEXT_PUBLIC_SENTRY_DSN` | No | DSN del navegador. Next lo inlinea en el bundle; el DSN es público. |
| `SENTRY_ENVIRONMENT` | No | `production`, `staging`, `development`. Default: `VERCEL_ENV` o `NODE_ENV`. |
| `SENTRY_RELEASE` | No | Versión/release. Default: `VERCEL_GIT_COMMIT_SHA` si existe. |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Muestreo **solo de traces** (0–1). Default: `0.1` en producción, `1` en desarrollo. No afecta errores. |
| `SENTRY_AUTH_TOKEN` | No (build/alertas) | Token para subir source maps y provisionar alertas. No se usa en runtime. |
| `SENTRY_ORG` / `SENTRY_PROJECT` | No (build/alertas) | Slugs de Sentry. |
| `SENTRY_ALERT_TARGET` | No | `user:<id>` o `team:<id>` para las notificaciones. Default: dueño del token. |
| `SENTRY_SLACK_INTEGRATION_ID` + `SENTRY_SLACK_CHANNEL` | No | Acción Slack opcional; se agregan las dos o ninguna. |

Sin `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` o `SENTRY_PROJECT`, `next.config.ts`
desactiva la subida de source maps (`sourcemaps.disable: true`); el build no
falla por no tener Sentry configurado.

## 3. Correlación con `x-request-id`

1. `proxy.ts` resuelve un `x-request-id` entrante (solo si tiene forma segura) o
   genera uno, lo reenvía a la ruta y lo devuelve en la respuesta.
2. `withRouteLogging` abre un `AsyncLocalStorage` con `requestId`, método y
   ruta. Todos los logs de la ruta lo incluyen.
3. `handleRouteError` captura la excepción en Sentry con el tag
   `request_id`. `onRequestError` hace lo mismo para errores no atrapados,
   leyendo el header del request.
4. `lib/api-client.ts` lee `x-request-id` de una respuesta 5xx y lo adjunta al
   evento de cliente. Así un error de UI y su log de servidor comparten id.

Búsquedas útiles:

- Sentry: `request_id:req-...` o `http.route:"/api/orders" http.response.status_class:5xx`.
- Logs: `requestId` en la línea JSON `request.completed` o `request.failed`.
- Un 5xx desde el navegador: tag `error.source:api-client` + `request_id`.

## 4. Métricas

Se emiten con **Sentry Application Metrics** (`Sentry.metrics`). No dependen del
`LOG_LEVEL` ni del sampling de traces: se registran aunque `tracesSampleRate`
sea 0. Las métricas son eventos agregados, no errores; Sentry las envía aparte.

| Métrica | Tipo | Atributos | Para qué |
| --- | --- | --- | --- |
| `http.server.requests` | counter | `http.route`, `http.request.method`, `http.response.status_code`, `http.response.status_class` | Volumen por ruta y tasa de 5xx. |
| `http.server.duration` | distribution (ms) | los anteriores | Latencia por ruta/método/status. |
| `http.server.errors` | counter | los anteriores + `error.type:5xx` | Conteo directo de 5xx. |
| `auth.login.attempts` | counter | `auth.outcome` | Intentos de login (`success`, `invalid_credentials`, `rate_limited`, `disabled`, `validation_error`, `server_error`). |
| `auth.login.failures` | counter | `auth.outcome` | Fallos de login, sin usuario ni IP. |
| `offline.queue.size` | gauge | `offline.online`, `offline.syncing` | Tamaño actual de la cola IndexedDB. |
| `offline.queue.sync_runs` | counter | `offline.synced`, `offline.failed`, `offline.retryable_failures` | Pasadas de sincronización offline. |
| `offline.queue.sync_failures` | counter | los anteriores | Pasadas con al menos un fallo. |
| `db.mongo.errors` | counter | `db.system`, `db.operation`, `error.name` | Errores de Mongo/Mongoose. |
| `db.mongo.health.checks` | counter | `db.mongo.status`, `db.mongo.ready_state`, `error.type` | Resultado del health check. |
| `db.mongo.health.duration` | distribution (ms) | los anteriores | Latencia del ping de Mongo. |
| `db.mongo.health.failures` | counter | los anteriores | Health checks no disponibles. |
| `client.api.errors` | counter | `http.route`, `http.request.method`, `http.response.status_code` | 5xx vistos desde el navegador. |
| `web.vitals.lcp` | distribution (ms) | `http.route`, `device.class`, `release`, `web.vital.rating`, `web.vital.navigation_type` | LCP real por ruta y dispositivo. |
| `web.vitals.inp` | distribution (ms) | los anteriores | INP real. |
| `web.vitals.cls` | distribution (ratio) | los anteriores | CLS real. |
| `web.vitals.ttfb` | distribution (ms) | los anteriores | TTFB real. |

La ruta se normaliza (`lib/observability/routes.ts`): ObjectIds, UUID, números y
tokens largos se reemplazan por `[id]`. No se usan query strings en atributos.

### Web Vitals

El cliente reporta LCP, INP, CLS y TTFB con `next/web-vitals`.

- `components/observability/WebVitalsLoader.tsx` espera al `load` y a que el
  navegador esté idle; recién ahí importa el reporter. El chunk de
  `next/web-vitals` no forma parte del bundle inicial.
- `components/observability/WebVitalsReporter.tsx` normaliza y emite con
  `recordWebVital`.
- Sin `NEXT_PUBLIC_SENTRY_DSN` no se descarga el reporter ni se emite nada.
- Atributos: ruta normalizada, `device.class` (`mobile`/`tablet`/`desktop`),
  `release` (`NEXT_PUBLIC_BUILD_ID`), rating y tipo de navegación.
- No se envía el `id` del metric, URL completa, query string, user agent,
  usuario, cookies ni cuerpos. Ver `docs/rendimiento-movil.md`.

Para calcular p75 por ruta y release en Sentry, agrupar por `http.route`,
`device.class` y `release`. Para el detalle de la línea base y los presupuestos,
ver [Rendimiento móvil](./rendimiento-movil.md).

### Tasa de 5xx

La tasa se calcula en Sentry/Grafana con las series anteriores:

```text
sum(http.server.errors) / sum(http.server.requests)
```

Filtrada por `http.response.status_class:5xx` y por entorno. El conteo absoluto
también sirve: un solo 5xx ya es accionable; el pico se alerta a partir de 5 en
5 minutos.

### Sampling: los errores no se muestrean

- `sampleRate: 1` en los tres runtimes (`ERROR_SAMPLE_RATE`).
- `SENTRY_TRACES_SAMPLE_RATE` solo controla traces/performance. Se puede poner
  en `0` y los errores se siguen enviando.
- `/api/health` no se traza (`tracesSampler` devuelve 0 para esa ruta), pero un
  503 sí genera evento y métrica.
- `scripts/test-observability.ts` verifica con un transporte en memoria que un
  error se envía con `tracesSampleRate: 0`.

## 5. Privacidad: qué no se envía

Regla: **nunca** se loguean cuerpos de request/response, contraseñas, cookies,
tokens ni query strings con datos personales.

Defensas implementadas:

1. `lib/logger.ts` solo registra metadatos (requestId, método, ruta, status,
   duración). `redactFields` reemplaza claves sensibles y `serializeError`
   redacta asignaciones tipo `password=...`.
2. `lib/api-errors.ts` no loguea el body; `parseJsonBody` devuelve un 400 sin
   registrar el contenido. El login solo registra el resultado
   (`auth.login.*`), nunca usuario ni contraseña.
3. Sentry: `sendDefaultPii: false` y `dataCollection` con:
   - `userInfo: false`, `cookies: false`;
   - `httpBodies: []`;
   - `urlQueryParams: false`;
   - `databaseQueryData: false`, `queues: false`;
   - `stackFrameVariables: false`;
   - headers limitados a `x-request-id`, `user-agent`, `content-type`,
     `accept`, `accept-language`.
4. `beforeSend`, `beforeBreadcrumb` y `beforeSendSpan` vuelven a limpiar:
   bodies, cookies, query strings, argumentos de consola, atributos
   `db.query.text`/`db.statement` y patrones de secretos.
5. Los breadcrumbs `console` se envían sin `data`; los `fetch`/`xhr` conservan
   método, URL sin query y status, pero no el body.

Si hace falta más contexto para depurar, agregar un tag acotado (por ejemplo
`order.status`) y **nunca** el documento completo.

## 6. Alertas

Las definiciones viven en `lib/observability/sentry-alerts.ts` y se provisionan
por API con `scripts/configure-sentry-alerts.ts`. El script es idempotente por
nombre: actualiza monitores/alertas existentes y no duplica.

```bash
# Ver los payloads sin tocar Sentry
npm run observability:alerts:dry

# Crear/actualizar (requiere token con alerts:write)
SENTRY_AUTH_TOKEN=... SENTRY_ORG=inventario SENTRY_PROJECT=sistema-gestion-inventario \
  npm run observability:alerts
```

En PowerShell:

```powershell
$env:SENTRY_AUTH_TOKEN = "..."
$env:SENTRY_ORG = "inventario"
$env:SENTRY_PROJECT = "sistema-gestion-inventario"
npm run observability:alerts
```

Qué crea:

| Alerta | Query (dataset `events`) | Ventana | Umbral |
| --- | --- | --- | --- |
| `Sistema de Gestión de Inventario · /api/health responde 503` | `http.route:"/api/health" http.response.status_class:5xx` | 5 min | > 0 → prioridad alta |
| `Sistema de Gestión de Inventario · Pico de respuestas 5xx` | `http.response.status_class:5xx` | 5 min | > 5 alta; > 1 media; ≤ 1 resuelve |
| `Sistema de Gestión de Inventario · Errores de MongoDB` | `error.source:mongodb` | 5 min | > 0 → prioridad alta |

Cada monitor se conecta a un workflow que notifica por email al destinatario
configurado. Si se definen `SENTRY_SLACK_INTEGRATION_ID` y
`SENTRY_SLACK_CHANNEL`, también se agrega la acción de Slack.

Notas:

- Las alertas se basan en **eventos de error**, no en traces, para que el
  sampling no las silencie.
- Para `/api/health` también se recomienda un **Uptime Monitor** de Sentry
  apuntando a `https://<host>/api/health` con intervalo de 1 minuto; es una
  segunda señal independiente de la app.
- Fallos de login: no generan un issue por cada 401 (sería ruido). Se monitorea
  la métrica `auth.login.failures`; un umbral razonable es > 20 en 10 minutos.
  Se puede crear el monitor desde **Explore → Metrics → Save as → Monitor**.
- Cola offline: crear un monitor de `offline.queue.size` con umbral > 25 durante
  15 minutos. Un valor alto sostenido indica que las escrituras no están
  sincronizando.
- El script no crea acciones de Slack/email nuevas: usa las integraciones ya
  instaladas en la organización.

Verificación después de correrlo:

1. **Monitors → Sistema de Gestión de Inventario** deben aparecer los tres monitores.
2. **Alerts** debe aparecer un workflow por monitor, con el email/Slack activo.
3. En **Explore → Metrics**, buscar `http.server.requests` y confirmar que hay
   datos del entorno correcto.
4. Forzar un 503 local (Mongo apagado) y confirmar que llega el evento con
   `http.route:/api/health` y `health.reason`.

## 7. Runbook rápido

### `/api/health` responde 503

1. `curl -i https://<host>/api/health` y mirar `checks.mongodb.error`.
2. Buscar el `x-request-id` de la respuesta en los logs (`requestId`).
3. En Sentry filtrar `http.route:"/api/health"`; el tag `health.reason` indica
   `connection-failed`, `ping-failed` o `not-connected`.
4. Revisar estado de MongoDB/Atlas, IP allowlist, credenciales y cupo de
   conexiones. No cambiar la URI sin coordinar; ver
   [backup/restore](./backup-restore-mongo.md).
5. Si el problema es de datos, restaurar según el runbook de backup.

### Pico de 5xx

1. Abrir el issue de Sentry y agrupar por `http.route`.
2. Tomar un `request_id`, buscar la línea `request.completed`/`request.failed`
   con ese id y revisar el stack.
3. Si coincide con un despliegue reciente, evaluar rollback.
4. Si el error es de Mongo (`error.source:mongodb`), seguir el punto anterior.

### Errores de Mongo

1. Confirmar `db.mongo.errors` y `db.mongo.health.*` en Metrics.
2. Revisar `error.name` (`MongoNetworkError`, `MongooseServerSelectionError`,
   etc.) y la operación (`connect`, `route`, `find`).
3. Validar conectividad desde el host de la app, no solo desde una laptop.
4. Si hay corrupción o borrado accidental, restaurar en una base temporal
   primero (ver [backup/restore](./backup-restore-mongo.md)).

### Fallos de login

1. Distinguir 401 (`invalid_credentials`) de 429 (`rate_limited`).
2. Un pico de 401 puede ser un cliente con credenciales viejas; un pico de 429
   puede ser fuerza bruta o una IP compartida.
3. El rate limit actual es en memoria y por proceso: en multi-instancia el
   límite efectivo se multiplica. Ver `docs/seguridad-cabeceras.md`.
4. No registrar usuario, IP ni contraseña en Sentry/logs.

### Cola offline creciendo

1. Confirmar `offline.queue.size` y `offline.queue.sync_failures`.
2. Revisar si el navegador está online y si el service worker está activo.
3. Errores 4xx no reintentables (por ejemplo un pedido ya no válido) requieren
   intervención manual; no borrar IndexedDB sin exportar/respaldar la cola.
4. Si el problema es del servidor, los 5xx aparecen en la misma ventana.

## 8. Retención

| Dato | Retención | Dónde |
| --- | --- | --- |
| Errores/traces/métricas de Sentry | 30–90 días según plan | Configuración de retención de Sentry |
| Logs JSON del proceso | 30 días recomendado | Plataforma de logs / rotación |
| Notificaciones (`Notification`) | 180 días (TTL) | MongoDB, ver `docs/notificaciones-retencion.md` |
| `NotificationRead` huérfanos | Limpieza diaria | `npm run notifications:cleanup` |
| Backups de Mongo | 7 diarios + 4 semanales + 12 mensuales | Ver `docs/backup-restore-mongo.md` |
| Pedidos/facturación | Definir con negocio (recomendado 5 años) | MongoDB; no hay TTL automático |

La retención de Sentry se configura en **Settings → Projects → <proyecto> →
Data Retention** (o el plan correspondiente). No se debe bajar de 30 días sin
acordar con soporte/negocio: los incidentes de producción suelen investigarse
semanas después.

## 9. Verificación local

```bash
npm run typecheck
npm test                 # incluye scripts/test-observability.ts
npm run build
npm run start            # runtime Node real
curl -i http://localhost:3000/api/health
curl -i http://localhost:3000/login
```

Comprobar:

- `/api/health` responde 200 o 503 con `x-request-id` y sin detalles internos.
- `next start` no falla si no hay DSN de Sentry (`SENTRY_DSN` vacío).
- Con `SENTRY_TRACES_SAMPLE_RATE=0`, el test de transporte confirma que los
  errores se siguen enviando.
- En los logs no aparece ningún body, contraseña, cookie ni query string.
