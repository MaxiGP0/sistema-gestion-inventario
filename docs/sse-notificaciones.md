# SSE de notificaciones: autenticación, filtrado y multi-instancia

Este documento registra las decisiones del ítem **P1 — SSE autenticado,
filtrado y confiable en multi-instancia**. El código vive en
`app/api/events/route.ts`, `lib/sse.ts` y `components/NotificationsBell.tsx`.

## 1. Autenticación y bandeja

`/api/events` **no es una ruta pública**. El proxy exige la cookie de sesión y
el handler vuelve a validarla con `requireSession()` (defensa en profundidad).

La bandeja no se acepta por query ni por body: se deriva del rol firmado en la
sesión.

| Rol de la sesión | Bandeja (`inbox`) | Recibe eventos |
| --- | --- | --- |
| `controlador` | `deposit` | `targetRole: 'deposit'` y `'all'` |
| `billing` | `billing` | `targetRole: 'billing'` y `'all'` |
| `admin` / `vendedor` | `all` | todos (`deposit`, `billing` y `all`) |

Cada conexión se guarda como `{ controller, userId, inbox, ip, connectedAt }`.
`broadcastEvent()` solo escribe en las conexiones cuya bandeja corresponde al
`targetRole` del evento. El mismo criterio se aplica al replay.

El componente vuelve a comprobar la correspondencia (`notificationMatchesInbox`)
antes de refrescar, así que un evento de otra bandeja no dispara consultas.

## 2. Formato y reconexión con `Last-Event-ID`

Cada evento se emite con id estándar SSE:

```text
id: 665f1f2a9b1e4c0012ab34cd
data: {"type":"notification","targetRole":"deposit","orderId":"...","eventId":"665f1f2a9b1e4c0012ab34cd","notification":{"id":"665f1f2a9b1e4c0012ab34cd","title":"Nuevo Pedido (Borrador)","message":"...","createdAt":"2026-01-01T12:00:00.000Z","targetRole":"deposit","orderId":"..."}}
```

* El id es el `_id` de la `Notification` cuando se pudo persistir; si no, se
  genera un UUID.
* `notification` viaja **solo** a las conexiones cuya bandeja coincide con el
  `targetRole` del evento. Admin/global y otras bandejas reciben el mismo
  evento sin esa carga y hacen el GET de respaldo. `NotificationsBell` usa el
  payload para deduplicar por id e insertar arriba sin pedir la lista; si no
  viene (servidores viejos) o la conexión se acaba de abrir/reconectar, hace el
  GET completo como antes.
* El servidor guarda un buffer acotado (`SSE_REPLAY_BUFFER_SIZE = 100`) por
  proceso. Si el navegador reconecta y envía `Last-Event-ID`, se reproducen
  solo los eventos posteriores que correspondan a la bandeja.
* Si el id ya no está en el buffer (proceso reiniciado, evento muy viejo o
  generado en otra instancia), no se inventa historial: `NotificationsBell`
  consulta la bandeja persistida al reconectar (`onopen` posterior a una
  conexión previa).
* `EventSource` reenvía `Last-Event-ID` de forma nativa; el cliente además
  deduplica por `event.lastEventId`.

El heartbeat es un comentario `: ping` cada `SSE_HEARTBEAT_MS = 25 s`. Antes de
enviarlo revalida el estado actual del usuario con la misma caché de sesión que
`requireCurrentSession` (`active`, `sessionVersion`, rol/bandeja). Si el usuario
fue dado de baja, reseteó su contraseña, cambió de rol o su versión ya no
coincide, la conexión recibe `event: session-expired` y se cierra; el cliente
vuelve a `/login`. Si el `enqueue` falla, la conexión se elimina y se limpia su
intervalo.

## 3. Límite de conexiones

Se permiten hasta **3 conexiones simultáneas por usuario** y **3 por IP**
(`SSE_MAX_CONNECTIONS_PER_USER` / `SSE_MAX_CONNECTIONS_PER_IP`). Al abrir una
nueva, se cierra la más vieja de ese usuario/IP.

La IP se toma del primer salto de `x-forwarded-for` o de `x-real-ip` (cabeceras
del proxy inverso). Si no hay ninguna, el límite por IP se omite y queda el
límite por usuario, que siempre está disponible porque hay sesión.

Antes de cerrar por límite se emite un evento con nombre `connection-limit`.
`NotificationsBell` lo escucha, cierra el `EventSource` y **no reintenta**; el
polling de seguridad sigue actualizando la bandeja. Esto evita que varias
pestañas se desalojen mutuamente en un ciclo de reconexiones.

## 4. Multi-instancia: estrategia elegida

Se eligió **(c) polling de seguridad cada 60 s aunque el SSE esté abierto**.

* `NotificationsBell` mantiene el respaldo rápido cada 10 s cuando el SSE está
  caído y, además, un poll de seguridad cada `SAFETY_POLL_MS = 60 s` mientras la
  pestaña está visible, incluso con SSE sano.
* Las notificaciones persistidas en Mongo son la fuente de verdad. El SSE es
  solo una capa de baja latencia y puede perderse un evento si el proceso que
  lo generó no es el mismo que atiende la conexión. Por eso el polling de
  seguridad sigue activo y la campana no depende del payload para reconciliarse.
* En pestañas ocultas no hay polling **ni conexión SSE**: al pasar a
  `document.hidden` se cierra el `EventSource` (evita también los reintentos
  automáticos del navegador) y al volver a primer plano se hace una consulta de
  puesta al día y se reabre el canal.
* Si el servidor desaloja la conexión con `connection-limit` no se reintenta
  mientras dure la página; el respaldo de 10 s mantiene la bandeja al día.
* Si recibe `session-expired`, cierra el canal y navega a `/login`: la cookie
  firmada ya no representa al usuario/rol actual y hay que reingresar.

**Por qué no (a) change streams:** requieren un replica set o mongos. El
repositorio admite un MongoDB local standalone, donde un change stream falla.
Se podría habilitar condicionalmente en un despliegue con replica set, pero
agregaría una rama de infraestructura y una conexión persistente por instancia.

**Por qué no (b) Redis pub/sub:** no hay Redis en las dependencias ni en el
despliegue actual. Agregarlo resolvería la entrega entre instancias con menor
latencia que 30 s, pero suma infraestructura, autenticación y operación.

Si más adelante se necesita latencia multi-instancia menor a 30 s, el orden
recomendado es:

1. Redis pub/sub entre instancias, manteniendo el polling como red de
   seguridad.
2. Change stream de Mongo solo si el despliegue garantiza replica set.

## 5. Respuesta de POST/PUT y patrón outbox

`POST /api/orders` y `PUT /api/orders/[id]` envuelven
`publishOrderNotification()` en `runAfterResponse()` (`lib/after-response.ts`),
que usa `after()` de `next/server`. La respuesta se envía apenas el pedido está
persistido; la notificación y el SSE corren después.

Esto mejora la latencia, pero mantiene una garantía **best-effort**: si el
proceso cae entre el `save()` y la notificación, la alerta se pierde. Si el
negocio exige no perder alertas, hay que implementar el **patrón outbox**
documentado en [`docs/atomicidad-pedidos.md`](./atomicidad-pedidos.md#4-patrón-outbox-entrega-garantizada):
evento pendiente en la misma transacción que el pedido (con replica set) o
inserción posterior con reconciliación (standalone), más un dispatcher que cree
la `Notification`, emita el SSE y marque el evento como enviado.

## 6. Web Push como canal adicional

Desde la misma tarea posterior a la respuesta, `publishOrderNotification()`
también invoca el dispatcher de Web Push (`lib/push-notifications.ts`). El SSE
sigue siendo el canal de baja latencia para pestañas abiertas; el push cubre el
caso de la app cerrada. Ambos comparten la `Notification` persistida y la
política best-effort: un fallo de push no altera el SSE ni la respuesta del
pedido. Detalles de configuración, filtros y limpieza de suscripciones en
[`docs/notificaciones-por-usuario.md`](./notificaciones-por-usuario.md#5-web-push-implementado).
