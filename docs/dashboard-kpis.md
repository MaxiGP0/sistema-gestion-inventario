# Panel operativo: datos, índices y mediciones

El panel (`app/page.tsx`) es un Server Component. La sesión se valida con
`requireRolePage(USER_ROLES)` y los datos se resuelven en el servidor antes de
enviar el HTML, sin el waterfall cliente `sesión → fetch → render`.

## Consultas

- **Conteos por estado**: un `countDocuments({ archived: false, status, ... })`
  por cada estado que gestiona el rol (5 para admin/vendedor, 2 para
  controlador y 3 para facturación), en paralelo. Los estados ajenos al rol se
  completan en `0` sin consultar Mongo. Cada count usa el índice
  `{ archived: 1, status: 1, createdAt: -1, _id: -1 }` con un `IXSCAN` /
  `COUNT_SCAN`.
- **Resumen de hoy**: un `aggregate` con `$match` por rango de fecha y
  `$group` para contar y sumar `finalTotal` en una sola pasada. Usa el índice
  `{ archived: 1, createdAt: -1, _id: -1 }`.
- **Últimos pedidos**: `find` con el orden del cursor `{ createdAt: -1, _id: -1 }`
  y un `limit` de 8. Para controlador y facturación se agrega el filtro de los
  estados que gestionan; el vendedor queda acotado por `buildOrderReadFilter`.
- **Zona horaria**: el día comercial se calcula en
  `America/Argentina/Buenos_Aires` (`lib/dashboard-time.ts`), sin depender de
  la zona horaria del proceso.
- **Importes**: todas las consultas aplican el scope de la sesión. El vendedor
  sólo suma sus propios pedidos, pero sí ve su `todayAmount` y las columnas de
  totales de sus últimos pedidos. Si tiene pedidos paralizados, el panel le
  muestra un banner de acción rápida hacia la bandeja filtrada.

## Por qué counts y no un aggregate de estados

Se compararon tres variantes sobre 30.000 pedidos sintéticos en MongoDB en
memoria (Node 24, Windows):

| Estrategia | Mediana |
| --- | ---: |
| 5 `countDocuments` en paralelo + aggregate de hoy + latest | **4,06 ms** |
| 1 `aggregate` `$match`/`$group` por estado + aggregate de hoy + latest | 11,93 ms |
| 1 aggregate con `$facet` para todo | 126,80 ms |

El `$group` por estado obliga a recorrer todos los pedidos no archivados;
los counts individuales resuelven por índice y son más baratos. El `$facet`
pierde el uso de índices después del primer `$match`, por eso se descartó.

La prueba `scripts/test-dashboard.ts` fija este contrato con `explain()`:
los counts deben usar `archived_1_status_1_createdAt_-1__id_-1` y el aggregate
del día `archived_1_createdAt_-1__id_-1`, ambos con `IXSCAN`.

## Tiempo de respuesta del dashboard

Medición con Playwright/Chromium, base E2E sembrada (6 pedidos), 7 navegaciones
por escenario después de calentar la ruta. Producción (`next build` +
`next start`):

| Versión | TTFB (mediana) | Contenido visible (mediana) | KPIs (mediana) |
| --- | ---: | ---: | ---: |
| Antes: Client Component + `/api/auth/session` | 5 ms | 77 ms | — |
| Después: Server Component + consultas | 4 ms | 67 ms (shell) | 72 ms |

En desarrollo el streaming de RSC agrega ~200-300 ms y no representa el
comportamiento de producción. La primera request de producción (sin calentar)
tardó 183 ms; las siguientes quedaron en 67-76 ms.

## Reproducir

- Pruebas de datos, agregación e índices: `npx tsx scripts/test-dashboard.ts`
  (incluida en `npm test`).
- E2E del panel: `npx playwright test e2e/dashboard.spec.ts`.
- Para volver a medir el tiempo: usar una base de prueba y el mismo flujo de
  Playwright con `next start` (no usar datos de producción).
