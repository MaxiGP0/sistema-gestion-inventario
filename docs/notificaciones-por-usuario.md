# Notificaciones por usuario

Este documento registra la decisión del ítem **P1 — Notificaciones por
usuario** e incluye la implementación de Web Push (sección 5).

## 1. Estado actual

Las notificaciones siguen siendo **compartidas por rol**:

* `Notification.targetRole` vale `deposit`, `billing` o `all`.
* Varios usuarios del mismo rol ven la misma notificación.

Lo que cambió es el **estado individual**: ya no existe un `read` global en
`Notification`. Cada usuario tiene una fila en la colección
`notificationreads`:

```ts
{
  _id: ObjectId,
  userId: ObjectId,          // usuario que leyó/descartó
  notificationId: ObjectId,  // notificación compartida
  readAt: Date,              // cuándo la marcó como leída
  dismissedAt: Date | null,  // cuándo la ocultó de su bandeja
  createdAt: Date,
  updatedAt: Date,
}
```

* Índice único `{ userId: 1, notificationId: 1 }`: una sola fila por usuario y
  notificación.
* Índice `{ notificationId: 1 }` para limpiar el estado cuando se borra la
  notificación (por ejemplo, al hard-delete de un pedido).
* `dismissedAt` es lo que permite que "Limpiar leídas" o borrar una
  notificación afecte **solo** a la bandeja del usuario que lo solicita. La
  notificación compartida no se borra.

Los documentos históricos pueden conservar el campo `read`; se ignora al
listar. No se migran automáticamente porque ese valor era global y no se puede
atribuir a un usuario concreto. Las notificaciones viejas aparecen como no
leídas para cada usuario hasta que las marque.

## 2. API

### `GET /api/users/notifications`

Bandeja del usuario autenticado. No acepta `userId` por query: siempre usa la
sesión firmada. Query opcional: `targetRole` (`deposit`, `billing`, `all`),
`cursor` y `limit` (1–100, por defecto 30).

* Sin `targetRole`, la bandeja por defecto depende del rol: depósito →
  `deposit`, facturación → `billing`, admin/vendedor → `all`.
* Cada notificación incluye `read` y `readAt` calculados para ese usuario.
* Las notificaciones con `dismissedAt` para ese usuario no se devuelven. El
  filtro se aplica **antes** del límite de la página: una notificación
  descartada no puede tapar una no leída más vieja.
* Paginación por cursor estable `{ createdAt: -1, _id: -1 }`. La primera página
  no lleva `cursor`; la siguiente se pide con `cursor=<nextCursor>` y el mismo
  `targetRole`/`limit`.
* Respuesta:

```json
{
  "success": true,
  "notifications": [
    {
      "_id": "...",
      "title": "Nuevo pedido",
      "message": "Pedido #123 listo para picking",
      "targetRole": "deposit",
      "orderId": "...",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "read": true,
      "readAt": "2026-01-01T00:01:00.000Z"
    }
  ],
  "inbox": "deposit",
  "notificationsEnabled": true,
  "pagination": {
    "mode": "cursor",
    "limit": 30,
    "hasMore": true,
    "nextCursor": "eyJjcmVhdGVkQXQiOi..."
  }
}
```

* `nextCursor` es opaco (base64url) y vale `null` en la última página.
* Un cursor corrupto responde `400` con
  `{ "error": "Cursor de paginación inválido" }`.
* `GET /api/notifications` mantiene el mismo contrato de paginación para la
  campana histórica.

### `PUT /api/users/notifications`

Guarda la preferencia personal:

```json
{ "notificationsEnabled": false }
```

Siempre actualiza al usuario de la sesión, nunca al `userId` del body. La
pantalla `/settings/notifications` consume este endpoint y refresca el contexto
global para que la campana reaccione sin recargar.

### Rutas históricas

`GET/PUT/DELETE /api/notifications` se mantienen para la campana:

* `GET` lista con el mismo filtro por rol, estado individual y paginación por
  cursor que `/api/users/notifications`.
* `PUT` marca leída/no leída una notificación o toda una bandeja **para el
  usuario autenticado**.
* `DELETE ?id=` descarta esa notificación solo para el usuario.
* `DELETE ?targetRole=` ("Limpiar leídas") descarta las ya leídas de esa
  bandeja solo para el usuario.

### "Marcar todas" acotado

`PUT /api/notifications` sin `id` y con `read: true` ya no carga todos los ids
de la bandeja ni hace un upsert por notificación en el proceso. Se resuelve con
un único `$merge` en MongoDB y una ventana de
`NOTIFICATION_MARK_ALL_WINDOW_DAYS = 90` días:

1. `$match` de la bandeja (`targetRole`) y `createdAt >= now - 90 días`.
2. `$project` del estado por usuario/notificación.
3. `$merge` en `notificationreads` con `on: [userId, notificationId]`. Si la
   fila existe solo actualiza `readAt`/`updatedAt` (preserva `dismissedAt`); si
   no existe la inserta.

Así el trabajo queda acotado y no depende de cuántos ids pueda retener el
proceso. Las notificaciones más viejas que la ventana se pueden marcar
individualmente y, de todos modos, salen por la retención de 180 días
(ver [`docs/notificaciones-retencion.md`](./notificaciones-retencion.md)).

## 3. Preferencia `notificationsEnabled`

* Valor por defecto: `true` (`models/User.ts`).
* La pantalla de preferencias permite activarla/desactivarla.
* Con la preferencia en `false`, `NotificationsBell` no consulta
  `/api/notifications`, no abre SSE y no muestra contador. La bandeja explica
  que están desactivadas y enlaza a la pantalla de preferencias.
* Las notificaciones se siguen creando para el resto del equipo: la
  preferencia es de recepción/aviso, no de generación.

## 4. Retención y limpieza

* `Notification` tiene un índice TTL de **180 días** sobre `createdAt`
  (`notification_retention_ttl`). MongoDB elimina las notificaciones vencidas
  automáticamente (el monitor TTL corre cada ~60 s).
* Al borrarse una notificación, sus filas de `NotificationRead` quedan
  huérfanas. Un cron diario ejecuta
  `scripts/cleanup-notification-reads.ts` para borrarlas en lotes.
* Los índices de listado incluyen `_id: -1` para que el cursor no ordene en
  memoria. Ver la migración y la operación del cron en
  [`docs/notificaciones-retencion.md`](./notificaciones-retencion.md).

## 5. Web Push (implementado)

Web Push es una **tercera capa** de aviso, además de la notificación persistida
y el SSE. No reemplaza a la bandeja ni al polling: si el navegador no soporta
push, el usuario no dio permiso o el servidor no tiene VAPID, las alertas
dentro de la app siguen funcionando igual.

### 5.1 Configuración VAPID

Variables del servidor (ver `.env.example`):

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

* Se generan una sola vez con `npx web-push generate-vapid-keys`. La clave
  privada nunca se envía al cliente ni se registra en logs.
* Las tres variables son **opcionales**, pero se validan en bloque: si se
  define una sola, `lib/env.ts` falla al arrancar indicando las que faltan.
  `VAPID_SUBJECT` debe ser un `mailto:` o una URL `https:`.
* Sin VAPID, `POST /api/users/push-subscriptions` responde `503`, el dispatcher
  no envía nada y la pantalla de preferencias muestra "servidor sin
  configurar". La app sigue operativa.

### 5.2 Modelo `PushSubscription`

`models/PushSubscription.ts`:

```ts
{
  _id: ObjectId,
  userId: ObjectId,          // usuario dueño del dispositivo
  endpoint: string,          // URL del servicio push
  keys: { p256dh, auth },    // claves de cifrado del navegador
  userAgent: string | null,
  createdAt: Date,
  lastUsedAt: Date,
}
```

* Índice **único** `{ endpoint: 1 }`: el endpoint identifica al navegador.
* Índice `{ userId: 1 }`: listado y revocación por usuario.
* Hasta **5 dispositivos** por usuario (`PUSH_SUBSCRIPTION_MAX_PER_USER`). Al
  superar el tope, el registro responde `409` y no se crea la fila.
* Si otro usuario inicia sesión en el mismo navegador, el endpoint se reasigna
  al usuario nuevo (no se duplica): la suscripción pertenece al dispositivo,
  no a la cuenta anterior.
* Al eliminar un usuario desde el backoffice se borran sus suscripciones.

### 5.3 API

Todas las rutas operan **siempre sobre el usuario de la sesión**. No aceptan
`userId` por query ni body.

#### `GET /api/users/push-subscriptions`

```json
{
  "success": true,
  "subscriptions": [
    {
      "id": "...",
      "endpoint": "https://fcm.googleapis.com/...",
      "userAgent": "Mozilla/5.0 ...",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "lastUsedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "publicKey": "B...",
  "maxSubscriptions": 5
}
```

Nunca devuelve `keys.p256dh` ni `keys.auth`. `publicKey` es la clave pública
VAPID (o `null` si Web Push no está configurado).

#### `POST /api/users/push-subscriptions`

Body validado con Zod:

```json
{
  "endpoint": "https://fcm.googleapis.com/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "userAgent": "Mozilla/5.0 ..."
}
```

* `endpoint` debe ser una URL `https:`; las claves son obligatorias y tienen
  un máximo de 512 caracteres.
* Es un upsert por `endpoint`: renovar la misma suscripción no consume un
  dispositivo ni duplica filas.
* Responde `409` al superar el límite de dispositivos y `503` sin VAPID.

#### `DELETE /api/users/push-subscriptions`

* `?endpoint=<url>` o body `{ "endpoint": "..." }`: revoca ese dispositivo.
* `?all=true` o body `{ "all": true }`: revoca todos los del usuario.
* Es idempotente: si no había nada, responde `200` con `removed: 0`.

### 5.4 Service worker

`public/sw.js` escucha `push` y `notificationclick`:

* `push` parsea `{ title, body, targetRole, orderId, url }`, muestra la
  notificación con el ícono de la app y guarda el destino en
  `notification.data`.
* `notificationclick` enfoca una pestaña existente y la navega, o abre una
  nueva. Solo acepta rutas internas (`/...`); una URL externa del payload se
  descarta.
* Destinos:
  * `deposit` → `/deposit/orders` o `/deposit/orders/:id`
  * `billing` → `/billing/orders` o `/billing/orders/:id`
  * `all` → `/` (el detalle es ambiguo entre bandejas)

El service worker no guarda notificaciones en caché: `notificationclick` abre
la ruta real, que siempre pasa por el proxy y la sesión.

### 5.5 Dispatcher

`lib/push-notifications.ts` se ejecuta desde `publishOrderNotification` después
de persistir la `Notification` y de emitir el SSE. Como
`publishOrderNotification` ya corre con `runAfterResponse`, el envío tampoco
bloquea la respuesta del POST/PUT del pedido.

* Destinatarios: usuarios **activos**, con `notificationsEnabled !== false` y
  rol destinatario:
  * `deposit` → `admin` y `controlador` (incluye el rol histórico `deposit`)
  * `billing` → `admin` y `billing`
  * `all` → todos los roles
* Se envían todas las suscripciones de esos usuarios con prioridad `urgency: 'high'` para entrega inmediata en móviles. `lastUsedAt` se actualiza
  al confirmar el envío.
* Éxito o error de un dispositivo no afecta a los demás.
* `404` y `410` del servicio push significan que la suscripción ya no existe:
  la fila se borra. Otros errores se registran y la fila se conserva.
* Cualquier fallo (Mongo, VAPID, red) queda en el log y **nunca** cambia el
  resultado del alta del pedido. Los tests de `test-order-side-effects.ts`
  cubren el 200 con push caído.

Payload enviado (JSON):

```json
{
  "title": "Nuevo pedido",
  "body": "Pedido #123 listo para picking",
  "targetRole": "deposit",
  "orderId": "...",
  "url": "/deposit/orders/..."
}
```

### 5.6 Pantalla `/settings/notifications`

* Botón explícito **“Activar notificaciones en este dispositivo”**. La página
  nunca llama a `Notification.requestPermission()` al cargar; el pedido ocurre
  solo dentro del clic.
* Estados visibles: comprobando, no soportado, permiso denegado, servidor sin
  VAPID, listo para activar, suscripto y error.
* Con la suscripción activa se ofrece **revocar este dispositivo**, que
  desuscribe el navegador (`PushSubscription.unsubscribe`) y borra la fila con
  `DELETE`.
* Se muestra la cantidad de dispositivos registrados y el tope.
* Si `notificationsEnabled` es `false`, el botón queda deshabilitado y un aviso
  explica que el servidor no enviará push aunque el navegador esté suscripto.
* En iOS/iPadOS se aclara que se requiere **iOS 16.4+ y la PWA instalada**
  (Compartir → Agregar a pantalla de inicio); en una pestaña de Safari no hay
  `PushManager`.

### 5.7 Pruebas

* `scripts/test-push-notifications.ts`: filtro por rol y preferencia, payload,
  deep links y limpieza 404/410.
* `scripts/test-push-subscriptions.ts`: registro, renovación, límite,
  reasignación, revocación y validación Zod.
* `scripts/test-sw-push.ts`: ejecuta `public/sw.js` en `node:vm` y verifica
  `push`/`notificationclick`.
* `scripts/test-order-side-effects.ts`: el alta responde 200 si falla el push.
* Prueba manual recomendada: Chrome/Android, activar desde la pantalla,
  cerrar la PWA y crear un pedido desde otro usuario.
