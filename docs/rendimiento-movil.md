# Rendimiento móvil: Web Vitals, presupuestos y CI

> Cierre del ítem 11 del plan del 24/10/2026. Base: `619cdd9`.
> La medición corre en un build de producción, con emulación móvil, no en
> `next dev`.

## 1. Qué se mide y dónde

| Capa | Herramienta | Rutas | Artefacto |
| --- | --- | --- | --- |
| RUM | `next/web-vitals` + Sentry Metrics | todas (cliente) | métricas `web.vitals.*` en Sentry |
| Bundle | `next build` + `scripts/measure-initial-js.mjs` | login, panel, alta, bandeja y detalle | tabla en CI |
| Performance real | Playwright + Chromium CDP | login, panel, alta, bandeja y detalle | `test-results/performance` |
| Lighthouse | Lighthouse 13 mobile | login, panel, alta, bandeja y detalle | `.lighthouseci` |

La regla es la misma del resto del plan: **medir en un teléfono de gama media a
390 px**, con CPU 4x y red lenta. Los presupuestos viven en
`performance-budgets.json` para que Playwright, Lighthouse y el chequeo de
bundle usen una única fuente.

## 2. Web Vitals desde el cliente

### Componentes

- `components/observability/WebVitalsLoader.tsx`: componente cliente mínimo que
  se monta en `app/layout.tsx`. Espera al evento `load` y a que el navegador esté
  idle antes de importar el reporter.
- `components/observability/WebVitalsReporter.tsx`: usa
  `useReportWebVitals` de `next/web-vitals` y llama a `recordWebVital`.
- `lib/observability/web-vitals.ts`: normaliza ruta, dispositivo, rating, tipo de
  navegación y release; descarta FCP y cualquier valor inválido.
- `lib/observability/metrics.ts`: `recordWebVital` emite una distribución por
  métrica con atributos acotados.

### Qué se envía

| Métrica | Nombre en Sentry | Unidad |
| --- | --- | --- |
| LCP | `web.vitals.lcp` | milisegundos |
| INP | `web.vitals.inp` | milisegundos |
| CLS | `web.vitals.cls` | ratio |
| TTFB | `web.vitals.ttfb` | milisegundos |

Atributos comunes:

- `http.route`: ruta normalizada con `[id]` para ObjectIds/UUIDs/números.
- `device.class`: `mobile` (< 768 px), `tablet` (< 1024 px) o `desktop`.
- `release`: `NEXT_PUBLIC_BUILD_ID` (SHA del commit en CI).
- `web.vital.rating`: `good`, `needs-improvement`, `poor` o `unknown`.
- `web.vital.navigation_type`: `navigate`, `reload`, `soft-navigation`, etc.

**No se envía PII**: ni `id` del metric, ni URL completa, ni query string, ni
user agent, ni usuario, ni cookies. La ruta ya se normaliza en el cliente y
Sentry vuelve a aplicar `beforeSendMetric`/redacción.

### Cómo activarlo

Sin `NEXT_PUBLIC_SENTRY_DSN` el loader no descarga el reporter: no hay sink y la
app no paga el chunk. Con DSN, Sentry se inicializa de forma diferida como ya
hacía `instrumentation-client.ts` y las métricas salen por
`Sentry.metrics.distribution`.

Consultas útiles en Sentry:

```text
# p75 de LCP por ruta y dispositivo
web.vitals.lcp  →  p75  →  group by http.route, device.class

# Sólo el release desplegado
web.vitals.lcp  release:abc123

# Regresión de INP en el alta
web.vitals.inp  http.route:/orders/new  device.class:mobile
```

### Peso en el bundle inicial

- El reporter (`next/web-vitals` incluido) viaja en un chunk diferido de
  **4,15 KB gzip**. No aparece en el HTML inicial.
- El loader añade **1,6 KB gzip** al JS inicial compartido (191,4 → 193,0 KB).
  Es el costo de programar la carga diferida, no el de la librería de Web
  Vitals. La comparación completa está en la sección 6.

## 3. Presupuestos de JavaScript inicial

El script `scripts/measure-initial-js.mjs` lee los HTML prerenderizados de
`.next/server/app`, suma los chunks `/_next/static/chunks/*.js` y fuentes
precargadas, y compara contra `performance-budgets.json`.

```bash
npm run build
npm run measure:js   # tabla informativa
npm run perf:bundle  # falla si una ruta supera el presupuesto
```

| Ruta | JS gzip actual | Presupuesto | JS sin comprimir |
| --- | ---: | ---: | ---: |
| `/login` | 193,0 KB | 200 KB | 618,1 KB |
| `/` (panel) | 193,0 KB | 200 KB | 618,1 KB |
| `/orders/new` (alta) | 193,0 KB | 200 KB | 618,1 KB |
| `/deposit/orders` (bandeja) | 193,0 KB | 200 KB | 618,1 KB |
| `/deposit/orders/[id]` (detalle) | 193,0 KB | 200 KB | 618,1 KB |

El resto de las rutas tiene un presupuesto por defecto de 210 KB gzip / 720 KB
sin comprimir. Si una ruta presupuestada desaparece del build, el script también
falla: así el CI no pasa por una ruta que dejó de medirse.

Para explorar la composición:

```bash
npm run analyze
# Resultados: .next/diagnostics/analyze
# Sin --output abre la UI interactiva de Next.
```

`@next/bundle-analyzer` queda disponible para builds con Webpack
(`ANALYZE=true next build --webpack`); el build estándar del repo usa Turbopack y
se explora con `next analyze`.

## 4. Performance móvil con Playwright

Config: `playwright.performance.config.ts`.
Spec: `e2e/performance.spec.ts`.

Entorno:

- Chromium con el perfil `Pixel 7` de Playwright.
- CPU 4x (`Emulation.setCPUThrottlingRate`).
- Red Fast 3G: 150 ms de latencia, 1,6 Mbps de bajada, 750 kbps de subida
  (`Network.emulateNetworkConditions`).
- Caché HTTP limpia antes de cada navegación.
- Build de producción (`next start`), base E2E efímera sembrada.
- 3 corridas por ruta; se publica la mediana.

Cada ruta hace una interacción corta para medir INP: foco + una tecla en login,
alta y bandeja; toggle de tema en panel y detalle. El INP es el peor evento de
esa interacción, no un INP de sesión completa.

### Línea base local (24/10/2026)

Mediana de 3 corridas, Node 24, Windows, Chromium headless:

| Ruta | LCP | INP | CLS | TBT | TTFB |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/login` | 612 ms | 16 ms | 0 | 0 ms | 7 ms |
| `/` | 660 ms | 72 ms | 0 | 0 ms | 5 ms |
| `/orders/new` | 620 ms | 32 ms | 0 | 0 ms | 5 ms |
| `/deposit/orders` | 636 ms | 40 ms | 0 | 0 ms | 4 ms |
| `/deposit/orders/[id]` | 612 ms | 48 ms | 0 | 0 ms | 5 ms |

Entre corridas el LCP se movió entre 580 y 696 ms y el TBT entre 0 y 148 ms.
Los presupuestos usan el extremo conservador.

Los presupuestos iniciales del plan (LCP < 2,5 s, INP < 200 ms, CLS < 0,1,
TBT < 300 ms) se ajustaron al baseline real para que detecten regresiones antes:

| Métrica | Baseline observado | Presupuesto |
| --- | ---: | ---: |
| LCP | 696 ms | 1.500 ms |
| INP | 72 ms | 150 ms |
| CLS | 0 | 0,05 |
| TBT | 148 ms | 250 ms |
| TTFB | 32 ms | 250 ms |

> TTFB se mide con `responseStart` en un servidor local; con CDP la latencia
> simulada no siempre se refleja en ese campo. Se mantiene como sanity check,
> no como sustituto de Lighthouse.

### Ejecución

```bash
# Build + base efímera + spec (recomendado en local)
npm run perf:playwright

# Si ya hiciste el build
npm run perf:playwright:run
```

El reporte JSON queda adjunto al test y los artefactos en
`test-results/performance`.

## 5. Lighthouse CI mobile

Script: `scripts/lighthouse-ci.mjs`.

- Levanta `next start` en `127.0.0.1:3200`.
- Si no hay `MONGODB_URI`, levanta y siembra un MongoDB efímero; en CI se usa el
  servicio de Mongo del workflow.
- Usa Chromium de Playwright y una sesión autenticada con el admin E2E.
- Preset mobile de Lighthouse 13: CPU 4x, throttling `mobileSlow4G` simulado,
  viewport 390×844.
- Corre 2 veces por ruta y publica la mediana.
- Reportes HTML/JSON y `summary.json` en `.lighthouseci/`.

### Línea base local (24/10/2026)

| Ruta | LCP | CLS | TBT | Score |
| --- | ---: | ---: | ---: | ---: |
| `/login` | 1.957 ms | 0 | 150 ms | 98 |
| `/` | 2.550 ms | 0 | 118 ms | 96 |
| `/orders/new` | 2.521 ms | 0 | 155 ms | 95 |
| `/deposit/orders` | 2.206 ms | 0 | 150 ms | 97 |
| `/deposit/orders/[id]` | 1.981 ms | 0 | 151 ms | 98 |

Presupuesto Lighthouse: **LCP ≤ 3.500 ms, CLS ≤ 0,05, TBT ≤ 300 ms**. El LCP
se ajustó al baseline con margen para runners de CI más lentos; en corridas
sucesivas el LCP mediano se movió entre 1,96 y 2,55 s y la corrida individual
más lenta observada fue 2,94 s. El objetivo de producto sigue siendo 2,5 s; el
presupuesto de CI evita que una regresión conocida pase desapercibida.

```bash
npm run build
npm run perf:lighthouse
```

Con un Mongo externo:

```bash
E2E_MONGODB_URI=mongodb://127.0.0.1:27017/sgi-e2e npm run seed:e2e
MONGODB_URI=mongodb://127.0.0.1:27017/sgi-e2e npm run perf:lighthouse
```

## 6. Antes / después de este PR

| Medición | Antes | Después |
| --- | ---: | ---: |
| JS inicial compartido (gzip) | 191,4 KB | 193,0 KB |
| JS inicial compartido (sin comprimir) | 612,6 KB | 618,1 KB |
| Chunk diferido de Web Vitals | — | 4,15 KB gzip |
| LCP/INP/CLS/TBT automatizados | no existían | baseline por ruta en este doc |
| Bundle budget en CI | no existía | `npm run perf:bundle` |
| Lighthouse mobile en CI | no existía | `npm run perf:lighthouse` + artifact |
| Performance Playwright en CI | no existía | `npm run perf:playwright:run` + artifact |

El +1,6 KB gzip del inicial es el loader que programa la carga diferida. La
librería `next/web-vitals` y el observer quedan fuera del HTML inicial.

Mejoras acumuladas de los ítems anteriores que este sistema ahora protege:

- Alta server-first: 215,8 → 189,0 KB gzip en `/orders/new`
  (`docs/alta-pedidos-server-first.md`).
- Bandejas y detalles server-first, listas largas con `content-visibility` y
  presupuesto de long tasks (`docs/rendimiento-listas-largas.md`).

En cada PR de este plan, adjuntar una tabla como la anterior con el antes/después
de las rutas tocadas. Si un presupuesto se cambia, explicar por qué y actualizar
`performance-budgets.json` en el mismo PR.

## 7. CI

El workflow `.github/workflows/ci.yml` tiene tres jobs relevantes:

1. `checks`: lint, formato, typecheck, tests, build, `perf:bundle`, `analyze` y
   artifact `bundle-analysis`.
2. `performance`: Mongo 7 como servicio, build, `perf:bundle`, seed,
   `perf:lighthouse`, `perf:playwright:run` y artifacts `lighthouse-report` /
   `performance-report`.
3. `e2e`: suite funcional completa, incluida la suite mobile de ergonomía y la
   PWA/offline.

Los reportes se publican como artifacts aunque el paso falle (`if: always()`),
para poder ver el antes/después de una regresión.

## 8. Cómo reproducir la línea base

```bash
npm ci
npm run build

# Bundle
npm run measure:js
npm run perf:bundle
npm run analyze

# Performance Playwright (build ya hecho)
npm run perf:playwright:run

# Lighthouse (build ya hecho)
npm run perf:lighthouse
```

Condiciones para comparar:

- Mismo build de producción, no `next dev`.
- Misma base sembrada (`npm run seed:e2e` o Mongo efímero).
- Mismo perfil móvil, CPU 4x y Fast 3G.
- Tres corridas en Playwright y dos en Lighthouse; usar la mediana.
- No comparar una corrida local con otra en CI sin margen: los runners
  compartidos tienen más varianza.
