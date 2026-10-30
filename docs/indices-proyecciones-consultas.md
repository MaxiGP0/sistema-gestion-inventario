# Índices y proyecciones de las consultas calientes

Revisión con `explain('executionStats')` de los listados de pedidos, clientes y
productos. La medición se hizo sobre una base temporal con 30.000 pedidos,
30.000 clientes y 20.000 productos, usando los índices declarados por los
schemas.

## Pedidos

| Consulta | Plan | keys / docs / devueltos |
| --- | --- | --- |
| `archived=false` + `status` + rango de `createdAt` | `IXSCAN(archived_1_status_1_createdAt_-1__id_-1)` | 50 / 50 / 50 |
| `archived=false` + `status $in` + rango de `createdAt` | `SORT_MERGE` de dos `IXSCAN` del mismo compuesto | 51 / 50 / 50 |
| `archived=false` + rango de `createdAt` (sin estado) | `IXSCAN(archived_1_createdAt_-1__id_-1)` | 50 / 50 / 50 |
| `archived=true` + rango de `createdAt` (sin estado) | `IXSCAN(archived_1_createdAt_-1__id_-1)` | 50 / 50 / 50 |

El compuesto de cuatro campos ya cubría estado + fecha + archivado. Faltaba el
caso **archivado + fecha sin estado**: al no declararlo, Mongo usaba
`createdAt_-1__id_-1` y, con `archived=true`, examinaba ~693 documentos para
devolver 50. Se agregó:

```js
{ archived: 1, createdAt: -1, _id: -1 }
```

El listado ya proyectaba sólo los campos de la tarjeta
(`clientId clientName clientCode status finalTotal createdBy createdAt archived
version items._id`) y el `populate` del cliente sigue reducido a
`code name localidad province`.

## Clientes

El listado sin búsqueda conserva `{ name: 1, _id: 1 }`: el plan es
`IXSCAN(name_1__id_1) -> FETCH -> LIMIT`, sin etapa de sort, y `_id` desempata
las páginas de forma estable.

La búsqueda ya no usa regex `i` no anclados sobre `code`, `name`, `localidad`,
`province` y `address`. Ahora consulta por prefijo las claves normalizadas
`searchName`, `searchCode`, `searchLocalidad`, `searchProvince` y
`searchAddress`, con un índice B-tree por campo. El detalle de la medición
antes/después, el fallback para documentos históricos y la migración están en
[`busquedas-escalables.md`](./busquedas-escalables.md).

El endpoint y el catálogo cacheado proyectan sólo
`code name address localidad province generalDiscount brandDiscounts`; quedan
fuera `createdAt`, `updatedAt` y `__v`.

## Productos

| Consulta | Plan | keys / docs / devueltos |
| --- | --- | --- |
| `brandId` + `active: { $ne: false }` + orden `name` | `IXSCAN(brandId_1_name_1_active_1)` | 50 / 50 / 50 |
| `active: { $ne: false }` + orden `name` (sin marca) | `IXSCAN(name_1_active_1)` | 56 / 56 / 50 |
| Búsqueda por prefijo normalizado | `OR` de `IXSCAN(searchName_1_active_1)`, `searchCode_1_active_1` y `brandId_1_name_1_active_1` | 212 / 180 / 50 |

El único `{ brandId: 1, code: 1 }` sólo acotaba por marca y dejaba el filtro de
`active` y el orden en memoria. Se agregaron:

```js
{ brandId: 1, name: 1, active: 1 }
{ name: 1, active: 1 }
{ searchName: 1, active: 1 }
{ searchCode: 1, active: 1 }
```

El orden `brandId, name, active` es intencional: con `active` antes de `name`,
`active: { $ne: false }` genera dos rangos y el planner prefiere escanear todo
el catálogo por `name` en lugar de usar la marca. La búsqueda de marcas también
pasó de un regex no anclado a `Brand.searchName` con prefijo indexado.

La proyección del listado ya era explícita
(`_id brandId code name imageUrl price priceWithIva`); se mantiene y se cubre
con pruebas. El alta de pedidos también proyecta ahora cliente
(`code name generalDiscount brandDiscounts`) y productos
(`code name price brandId`) en vez de traer los documentos completos.

## Aplicar en una base existente

```bash
npx tsx scripts/migrate-query-indexes.ts
```

El script usa `syncIndexes()` sobre `Order`, `Client` y `Product`: crea los
índices nuevos y elimina los que ya no declara el schema. Es idempotente.

Para las claves normalizadas de búsqueda y sus índices:

```bash
npm run search:migrate -- --dry-run
npm run search:migrate
```
