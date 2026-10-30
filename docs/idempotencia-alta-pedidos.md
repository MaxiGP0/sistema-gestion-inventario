# Idempotencia del alta de pedidos

Contrato de `POST /api/orders` para que un reintento —manual, por un timeout o
desde la cola offline— devuelva el pedido ya creado en lugar de insertar otro.

## 1. Clave del cliente

* La app genera un **UUID v4** (`crypto.randomUUID()`) por cada operación de
  alta: `lib/order-request-id.ts`.
* El mismo valor viaja en el body como `clientRequestId` y se guarda junto al
  body en IndexedDB (`lib/offline-order-queue.ts`).
* La clave es opcional para clientes viejos; si no viene, el alta se comporta
  como siempre.
* Longitud máxima: **120 caracteres**. Se recorta el espacio exterior y una
  cadena vacía o demasiado larga responde **400** antes de tocar la base.
* La clave debe ser **estable para una misma operación** y no reutilizarse para
  otro contenido. Si se repite con un body distinto, el servidor sigue
  devolviendo el primer pedido creado.

## 2. Alcance y almacenamiento

El pedido guarda `clientRequestId` y el índice declarado en `models/Order.ts`
es:

```js
OrderSchema.index(
  { createdById: 1, clientRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRequestId: { $type: 'string' } },
  },
);
```

* El alcance es **usuario + clave**: dos usuarios pueden usar el mismo UUID sin
  colisionar.
* El filtro parcial deja convivir todos los pedidos históricos sin clave.
* El índice se aplica con `syncIndexes()` / los scripts de migración del repo;
  en una base nueva lo crea Mongoose al sincronizar el modelo.

## 3. Comportamiento HTTP

| Situación | Respuesta |
| --- | --- |
| Primera petición válida | **200** con el pedido creado y la notificación habitual. |
| Reintento con la misma clave del mismo usuario | **200** con el mismo pedido y `deduplicated: true`; no inserta ni notifica de nuevo. |
| Dos peticiones concurrentes con la misma clave | Una gana el índice único; la otra captura `E11000`, busca el pedido ganador y responde **200** con `deduplicated: true`. |
| Clave vacía o de más de 120 caracteres | **400** de validación. |
| Body inválido, sin permisos o cliente/producto inexistente | **4xx**; no se guarda nada. |
| Error transitorio (red, timeout, 5xx, 408, 429, 401) | La cola conserva la entrada y reintenta. |

La respuesta del reintento conserva la forma de `OrderMutationResponse`:

```json
{
  "success": true,
  "message": "El pedido ya había sido creado; se devuelve el pedido existente",
  "order": { "_id": "...", "status": "borrador", "...": "..." },
  "deduplicated": true
}
```

## 4. Cola offline

`lib/offline-order-queue.ts` usa IndexedDB (`sgi-offline`, versión 2) con una
sola cola ordenada por `createdAt`:

| Tipo | Clave | Método | Deduplicación local |
| --- | --- | --- | --- |
| Alta | `create:<clientRequestId>` | `POST /api/orders` | La misma clave reemplaza la entrada. |
| Picking | `update:<orderId>` | `PUT /api/orders/[id]` | Un nuevo picking reemplaza al anterior. |

La versión 2 migra automáticamente las entradas de la versión 1
(`order-put-queue`) sin perder pickings pendientes.

En `app/orders/new/page.tsx`:

1. Si `navigator.onLine === false`, se encola directamente.
2. Si el POST falla por red o por un estado transitorio, se encola el mismo
   body con la misma clave.
3. Se limpia el borrador, se muestra **“Pendiente de sincronizar”** y se
   registra el tag de Background Sync.
4. `OfflineSyncIndicator` y `order-put-sync-core` drenan la cola al volver
   online, al recuperar foco/visibilidad y cuando el service worker despierta
   por Background Sync. La cola se procesa en orden, se detiene ante un fallo
   transitorio y omite las entradas que ya quedaron fallidas.
5. Un **4xx** no reintentable no se descarta: queda en la cola con
   `status: 'failed'`, `lastError`, `lastStatus` y `lastAttemptAt`. El indicador
   abre **“Cola de sincronización”** para restaurar un alta en el borrador de
   `/orders/new`, abrir el pedido actual de un picking con conflicto o descartar
   la entrada de forma explícita.

## 5. Límites

* Si el usuario borra los datos del navegador, la cola local se pierde.
* La idempotencia evita duplicados, pero no convierte un body inválido en uno
  válido: los 4xx quedan visibles en la cola para que el usuario corrija el
  borrador o descarte el cambio.
* La sesión puede vencer mientras el pedido está en cola; el reintento devuelve
  401 y la entrada se conserva hasta que el usuario vuelva a iniciar sesión.
* La notificación del alta es best-effort (ver
  [`docs/atomicidad-pedidos.md`](./atomicidad-pedidos.md)); el reintento
  idempotente no la repite.
