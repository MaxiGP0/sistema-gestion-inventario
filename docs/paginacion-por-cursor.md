# Paginación por cursor en pedidos

Las bandejas de **depósito** y **facturación** listan pedidos con paginación
por cursor y carga incremental. El objetivo es que el costo de abrir la
siguiente página no crezca con la cantidad de pedidos: no se usa `skip` y el
`countDocuments` se ejecuta sólo en la primera página.

El mismo cursor `{ createdAt: -1, _id: -1 }` se usa en la bandeja de
notificaciones (`GET /api/users/notifications` y `GET /api/notifications`); el
detalle de esa variante está en
[`docs/notificaciones-retencion.md`](./notificaciones-retencion.md).

## Contrato del API

`GET /api/orders` mantiene la paginación histórica por `page`/`limit` para
otros clientes, y suma un modo por cursor:

```
GET /api/orders?status=borrador,paralizado&archived=false
    &pagination=cursor&limit=50
```

La primera página no lleva `cursor`; la respuesta incluye:

```json
{
  "orders": ["..."],
  "pagination": {
    "mode": "cursor",
    "limit": 50,
    "hasMore": true,
    "nextCursor": "eyJjcmVhdGVkQXQiOi...",
    "total": 1234
  }
}
```

- `total` sólo viaja en la primera página (sin `cursor`).
- `nextCursor` es opaco (base64url); el cliente no debe interpretarlo.
- La página siguiente se pide con `cursor=<nextCursor>` y el mismo filtro.
- Si `hasMore` es `false`, `nextCursor` es `null`.
- Un cursor corrupto responde `400` con `{ "error": "Cursor de paginación inválido" }`.

## Orden estable

El listado se ordena por `{ createdAt: -1, _id: -1 }`. Incluir `_id` desempata
los pedidos con el mismo `createdAt`; sin ese desempate un cursor podría
repetir u omitir documentos. El filtro de la página siguiente es:

```js
{
  $or: [
    { createdAt: { $lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
  ],
}
```

## Índices

Los índices de listado incluyen `_id: -1` para que MongoDB resuelva el filtro
y el orden sin una etapa de sort en memoria:

- `{ archived: 1, status: 1, createdAt: -1, _id: -1 }`
- `{ status: 1, createdAt: -1, _id: -1 }`
- `{ clientId: 1, createdAt: -1, _id: -1 }`
- `{ createdAt: -1, _id: -1 }`

En una base existente, reemplazar los índices viejos (sin `_id`) por estos:

```bash
npx tsx scripts/migrate-order-cursor-indexes.ts
```

La migración usa `Order.syncIndexes()`: crea los índices nuevos y elimina los
que ya no declara el schema. Es idempotente.

## UI

`hooks/useOrderCursorList.ts` centraliza la carga de las dos bandejas:

- debounce de 300 ms para el buscador;
- descarte de respuestas obsoletas con un id de request;
- deduplicación por `_id` al anexar páginas;
- botón **Cargar más** mientras `hasMore` sea verdadero;
- al archivar/eliminar, quita la tarjeta y ajusta el total mostrado.

Se optó por carga incremental en lugar de virtualización DOM: las tarjetas
tienen alturas variables y el listado ya se pagina en el servidor, así que el
DOM crece sólo con las páginas que el usuario decide cargar.
