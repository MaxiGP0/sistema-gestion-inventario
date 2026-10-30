# Atomicidad y concurrencia en pedidos

Este documento registra la decisión tomada para el ítem **P0 — Atomicidad y
concurrencia en pedidos** y el patrón a seguir si más adelante se exige entrega
garantizada de notificaciones.

## 1. Control de versión optimista

`models/Order.ts` usa el `versionKey` de Mongoose con el nombre `version` y
`optimisticConcurrency: true`:

* Cada pedido nuevo arranca en `version: 0`.
* Cada `save()` exitoso incrementa `version` y el update incluye la versión
  leída en el filtro. Si otro proceso guardó antes, Mongoose lanza
  `VersionError` y no pisa los cambios ajenos.
* `PUT /api/orders/[id]` exige `version` en el body. Antes de mutar compara la
  versión enviada con la actual y, si no coincide, responde **409** con
  `{ error, code: "ORDER_VERSION_CONFLICT", version }`.
* La carrera entre el `findById` y el `save()` también se traduce a 409: el
  `VersionError` se captura en el handler y nunca se devuelve como 500.
* Los clientes (detalle de depósito/facturación y archivado de las bandejas)
  envían la versión recibida por la API. Ante un 409 deben recargar el pedido y
  reintentar la operación.

Los pedidos históricos sin `version` se tratan como versión `0` al leerlos; el
primer guardado les asigna la versión administrada por Mongoose.

## 2. Efectos secundarios best-effort

La notificación persistida, el evento SSE y el envío de Web Push se movieron a
`lib/order-side-effects.ts` (`publishOrderNotification`). Se ejecutan después de
guardar el pedido, **fuera del camino crítico** vía `after()` de `next/server`
(`runAfterResponse` en `lib/after-response.ts`), y **nunca lanzan**:

* Si `Notification.create` falla, el error queda en `console.error` y la
  respuesta del pedido sigue siendo 200. Sin notificación persistida tampoco se
  intenta el push.
* Si `broadcastEvent` o el dispatcher de Web Push fallan, ocurre lo mismo.
* El objetivo es que un problema de Mongo, del bus SSE o de un servicio push no
  convierta una escritura ya confirmada en un error para el usuario, ni demore
  la respuesta.

Esto implica una garantía **best-effort** (como máximo un intento): el pedido
puede quedar guardado sin notificación si el proceso falla en ese intervalo.
La parte SSE (autenticación, filtrado, reconexión y estrategia multi-instancia)
se documenta en [`docs/sse-notificaciones.md`](./sse-notificaciones.md) y Web
Push en
[`docs/notificaciones-por-usuario.md`](./notificaciones-por-usuario.md#5-web-push-implementado).

## 3. Evaluación de transacciones de Mongo

Las transacciones multi-documento requieren un **replica set** (o un cluster
sharded). Un `mongod` local arrancado en modo standalone no las soporta.

El despliegue de este repositorio no está fijado a un replica set: el README
admite tanto un MongoDB local (`mongodb://127.0.0.1:27017/sistema-gestion-inventario`) como Atlas.
Por eso **no se agregó una transacción** alrededor de `order.save()` +
`Notification.create()`: en el caso local standalone fallaría con
`Transaction numbers are only allowed on a replica set member or mongos`.

Para verificar el entorno antes de habilitarlas:

```js
// mongosh
rs.status()                 // debe devolver un replica set configurado
db.hello().setName          // nombre del replica set (Atlas siempre lo tiene)
```

Si se migra a Atlas o a un replica set propio, se puede pasar a la variante
transaccional del patrón outbox (sección 4).

## 4. Patrón outbox (entrega garantizada)

Cuando la notificación no pueda perderse, el reemplazo del helper best-effort
es un **outbox transaccional**:

1. Crear la colección `OrderOutbox` (o `OrderEvent`) con documentos como:

   ```ts
   {
     _id,
     eventId: string,          // idempotencia (único)
     orderId: ObjectId,
     type: 'order.ready_to_bill',
     payload: { targetRole: 'billing', title, message },
     status: 'pending' | 'sent' | 'failed',
     attempts: number,
     nextAttemptAt: Date,
     createdAt: Date,
     sentAt?: Date,
   }
   ```

2. **Con replica set:** en una sesión/transacción, guardar el pedido e insertar
   el evento `pending` juntos. Si la transacción aborta, no queda ni pedido ni
   evento; si confirma, el evento existe aunque el proceso caiga antes de
   notificar.

3. **Sin transacciones (standalone):** guardar primero el pedido y luego
   insertar el evento. Si la inserción falla, el pedido ya está confirmado: un
   job de reconciliación debe buscar pedidos en `facturacion` sin evento
   asociado y crearlo. La entrega pasa a ser **at-least-once**, por lo que el
   `eventId` único y la deduplicación en el consumidor son obligatorios.

4. Un **dispatcher** (cron, worker o ruta interna protegida) lee los eventos
   `pending` con `nextAttemptAt <= now`, crea la `Notification`, emite el SSE y
   marca `sent`. Ante error incrementa `attempts`, aplica backoff y, tras un
   máximo configurable, marca `failed` para revisión manual.

5. El SSE sigue siendo un aviso best-effort: si el cliente estaba desconectado,
   al reconectar vuelve a listar las notificaciones persistidas. El outbox
   garantiza la persistencia, no la entrega en vivo.

Mientras no exista ese outbox, el comportamiento actual es el documentado en la
sección 2: pedido consistente por versión optimista y notificación best-effort.
