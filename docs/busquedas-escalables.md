# Búsquedas escalables de clientes, productos y pedidos

Medición y cambios del ítem 13 del plan de mejoras (octubre 2026) y del ítem 2
del plan del 29/10/2026. El objetivo era dejar de recorrer la colección en cada
keystroke del autocompletado, que los `countDocuments` de la primera página no
cayeran en `COLLSCAN` y que la bandeja de pedidos pudiera buscar por prefijo de
cliente, vendedor, código o producto.

## Cómo reproducir la medición

```bash
npm run search:explain
```

El script `scripts/explain-search.ts` levanta MongoDB en memoria, genera 30.000
clientes, 30.000 productos y 30.000 pedidos, y ejecuta
`explain('executionStats')` sobre el listado y el conteo de cada buscador. No
toca la base configurada en `MONGODB_URI`. Se puede cambiar el volumen con
`EXPLAIN_DOCS=50000 npm run search:explain`.

## Antes / después

Término medido: `Gómez` (mayúsculas y acento incluidos). `keys` son las claves
de índice examinadas, `docs` los documentos leídos y `devueltos` los que salen
en la primera página de 50.

### Clientes — `GET /api/clients?search=Gómez`

| Camino | Plan | keys / docs / devueltos | find | count keys / docs |
| --- | --- | --- | --- | --- |
| Antes: regex `i` no anclado sobre 5 campos | `IXSCAN(name_1__id_1) -> FETCH -> LIMIT` | 29.990 / 29.990 / 50 | 104 ms | 0 / 30.000 (`COLLSCAN`) |
| Después: prefijo sobre `search*` | `OR` de `IXSCAN(searchName_1)`, `searchCode_1`, `searchLocalidad_1`, `searchProvince_1`, `searchAddress_1` + `SORT` acotado | 63 / 60 / 50 | 6 ms | 63 / 0 |

El índice de `name` servía para el orden, pero no para el filtro: había que
recorrer casi toda la colección hasta juntar 50 coincidencias. El `count` era
peor: un `COLLSCAN` completo. Con las claves normalizadas el prefijo acota el
rango del índice y el conteo también queda indexado.

### Productos — `GET /api/products?search=Gómez`

| Camino | Plan | keys / docs / devueltos | find | count keys / docs |
| --- | --- | --- | --- | --- |
| Antes: regex `i` en producto + `Brand.find` con otro regex | `IXSCAN(name_1_active_1) -> FETCH -> LIMIT` | 51 / 51 / 50 | 1 ms | 0 / 30.000 (`COLLSCAN`) |
| Después: prefijo en `searchName`/`searchCode` y marca `searchName` | `OR` de `IXSCAN(searchName_1_active_1)`, `searchCode_1_active_1`, `brandId_1_name_1_active_1` + `SORT` acotado | 212 / 180 / 50 | 5 ms | 212 / 0 |

El listado ya tenía un índice razonable para el orden, pero el conteo recorría
toda la colección y la búsqueda de marcas hacía otro regex no anclado. Ahora la
marca se resuelve por prefijo normalizado y el `$in` de `brandId` sigue usando
el compuesto existente.

### Pedidos — `GET /api/orders?search=Gómez`

| Camino | Plan | keys / docs / devueltos | find | count keys / docs |
| --- | --- | --- | --- | --- |
| Antes: `$text` + sort `createdAt` | `SORT -> FETCH -> TEXT_MATCH(order_search_text)` | 1.635 / 3.270 / 50 | 7 ms | 1.635 / 3.270 |
| Después: tokens sobre `searchTokens` | `LIMIT -> FETCH -> IXSCAN(archived_1_createdAt_-1__id_-1)` | 134 / 134 / 50 | 6 ms | 11.091 / 0 |

MongoDB `$text` sólo matchea palabras completas (o su raíz): escribir `"Ahor"`
no encontraba `"Supermercado El Ahorro"` y buscar `"shampoo 400"` no llegaba a
las líneas del pedido. Ahora `searchTokens` incluye cliente, vendedor, código
corto y los snapshots de cada ítem (`productCode`, `productName`, `brandName`).

El índice compuesto `{ archived: 1, searchTokens: 1, createdAt: -1, _id: -1 }`
resuelve el filtro fijo de la bandeja y el orden del cursor. Cuando el término es
poco selectivo el planner prefiere el índice de `archived + createdAt` y filtra
sobre él; cuando el multikey acota mejor, usa `searchTokens`. En ningún caso hay
`COLLSCAN`, y el `count` de la primera página sigue usando un índice.

## Qué se agregó

Clientes:

```js
searchName, searchCode, searchLocalidad, searchProvince, searchAddress
```

Productos:

```js
searchName, searchCode
```

Marcas:

```js
searchName
```

Pedidos:

```js
searchTokens // cliente, vendedor, shortId e ítems
```

Todas las claves se guardan en minúsculas, sin acentos (NFD + eliminación de
marcas) y con espacios colapsados. La consulta normaliza igual el término y usa
`/^clave/`, que MongoDB puede acotar con un índice B-tree.

Índices:

```js
Client:  { searchName: 1 }, { searchCode: 1 }, { searchLocalidad: 1 },
         { searchProvince: 1 }, { searchAddress: 1 }
Product: { searchName: 1, active: 1 }, { searchCode: 1, active: 1 }
Brand:   { searchName: 1 }
Order:   { archived: 1, searchTokens: 1, createdAt: -1, _id: -1 }
```

Se conservan los índices de orden (`Client { name: 1, _id: 1 }`,
`Product { name: 1, active: 1 }`, etc.) porque los listados sin búsqueda
siguen usándolos.

## Fallback y compatibilidad

- Los documentos históricos sin campos `search*` siguen apareciendo: la consulta
  incluye ramas `{ searchName: { $exists: false }, name: /termino/i }` (y
  equivalentes por campo). En pedidos sin `searchTokens` se compara con regex `i`
  sobre `clientName`, `clientCode`, `createdBy`, `items.productName` y
  `items.productCode`. Esas ramas también se resuelven con los índices nuevos;
  una vez completo el backfill no devuelven documentos.
- En pedidos, un token hexadecimal de 4 a 6 caracteres se busca a la vez como
  código corto (`#xxxxxx`) y como parte de un código o nombre, porque `"cafe"`
  puede ser cualquiera de los dos. Un `#` explícito o un ObjectId completo
  mantienen el atajo por `shortId`/`_id`.
- El alias `q`, el debounce de 300 ms, la paginación y el orden por nombre no
  cambiaron.
- La búsqueda por prefijo reemplaza la coincidencia parcial en cualquier
  posición. Es el comportamiento esperado de un autocompletado y el que permite
  usar índices; las claves cubren nombre, código, localidad, provincia y
  domicilio de clientes, y nombre/código/marca en productos.
- No se usó Atlas Search: el deploy soporta MongoDB local/Atlas sin depender de
  un índice Atlas Search. El camino B-tree funciona en ambos. Si más adelante se
  adopta Atlas Search, se puede sumar como backend opcional manteniendo estas
  consultas como fallback.

## Migración y backfill

```bash
# Ver cuántos documentos cambiarían, sin escribir ni tocar índices
npm run search:migrate -- --dry-run

# Rellenar claves y sincronizar índices
npm run search:migrate

# Lotes más grandes (default 500)
npm run search:migrate -- --batch-size=1000
```

`scripts/migrate-search-fields.ts` usa `backfillSearchFields()` de
`lib/search-backfill.ts` y `syncIndexes()` de Mongoose. Sólo actualiza los
documentos cuyas claves cambiaron y la segunda corrida informa `0` cambios, por
lo que es idempotente. En pedidos completa además `shortId` desde `_id` y suma
ese código a `searchTokens`; `syncIndexes()` elimina el índice legacy
`order_search_text`. La importación masiva de catálogo (`bulkWrite`) calcula las
claves explícitamente porque ese camino no ejecuta los hooks de Mongoose.

## Pruebas

- `scripts/test-client-indexes.ts`, `scripts/test-product-indexes.ts` y
  `scripts/test-order-indexes.ts` fijan la forma de la consulta, los índices
  declarados y el escape de términos.
- `scripts/test-search-normalization.ts` prueba acentos/mayúsculas, hooks de
  `save`/`findOneAndUpdate`, backfill idempotente de clientes/productos/pedidos y
  que el listado y el count usen índices (sin `COLLSCAN`) contra MongoDB en
  memoria.
