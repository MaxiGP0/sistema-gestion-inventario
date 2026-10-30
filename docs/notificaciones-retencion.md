# Retención y limpieza de notificaciones

Este documento cubre la retención de `Notification`, la limpieza de
`NotificationRead` huérfanos y la paginación por cursor de la bandeja. El
código vive en `models/Notification.ts`, `models/NotificationRead.ts`,
`lib/notifications.ts`, `lib/notification-retention.ts` y
`scripts/cleanup-notification-reads.ts`.

## 1. Retención TTL de 180 días

El schema de `Notification` declara:

```ts
NotificationSchema.index(
  { createdAt: 1 },
  {
    name: 'notification_retention_ttl',
    expireAfterSeconds: 180 * 24 * 60 * 60,
  },
);
```

MongoDB elimina los documentos cuando `createdAt` queda por debajo del corte de
180 días. El monitor TTL corre aproximadamente cada 60 segundos, así que la
baja efectiva puede demorar hasta un minuto más. Los índices de listado
(`{ targetRole: 1, createdAt: -1, _id: -1 }` y
`{ createdAt: -1, _id: -1 }`) se mantienen separados porque un índice TTL debe
ser de un solo campo.

### Crear o actualizar los índices

En una base existente, correr una vez por entorno:

```bash
npm run notifications:migrate-indexes
# equivale a: npx tsx scripts/migrate-notification-indexes.ts
```

El script usa `Notification.syncIndexes()` y
`NotificationRead.syncIndexes()`: crea los índices declarados (incluido el TTL
y el único `{ userId, notificationId }` que usa `$merge`) y elimina los viejos
que ya no están en el schema. Es idempotente. El índice único de
`NotificationRead` es obligatorio para el upsert masivo de "marcar todas".
Verificar el resultado con:

```js
db.notifications.getIndexes()
```

Debe aparecer `notification_retention_ttl` con `expireAfterSeconds: 15552000`.

## 2. Limpieza de `NotificationRead` huérfanos

Cuando la retención TTL (o el hard-delete de un pedido) borra una
notificación, las filas de `notificationreads` asociadas quedan huérfanas. El
script las detecta y borra en lotes:

```bash
# Ver cuántos huérfanos hay sin borrar nada
npx tsx scripts/cleanup-notification-reads.ts --dry-run

# Borrar en lotes de 1.000 (valor por defecto)
npm run notifications:cleanup

# Ajustar lote o limitar la ejecución
npx tsx scripts/cleanup-notification-reads.ts --batch-size=500 --max-batches=10
```

Cómo funciona:

1. Recorre `NotificationRead` por cursor de `_id` (`find({ _id: { $gt } })`),
   así no carga la colección completa ni usa `skip`.
2. Por cada lote consulta qué notificaciones siguen existiendo con un único
   `$in` sobre `_id`.
3. Borra solo las filas cuyo `notificationId` ya no existe.
4. Imprime un JSON con `scanned`, `orphans`, `deleted`, `batches` y
   `durationMs` (y progreso por lote).

Es idempotente y se puede correr más de una vez. `--dry-run` no modifica la
base.

### Cron sugerido

Linux (crontab), todos los días a las 03:15:

```cron
15 3 * * * cd /srv/sistema-gestion-inventario && npm run notifications:cleanup >> /var/log/sgi-notifications-cleanup.log 2>&1
```

Windows (Programador de tareas), comando:

```text
powershell -NoProfile -Command "cd C:\ruta\sistema-gestion-inventario; npm run notifications:cleanup *>> C:\logs\sgi-notifications-cleanup.log"
```

### GitHub Actions

El repo incluye
[`.github/workflows/notifications-cleanup.yml`](../.github/workflows/notifications-cleanup.yml).
Corre todos los días a las 03:15 UTC y también se puede disparar a mano desde
**Actions → Notifications cleanup → Run workflow** (con opción `dry_run`).

Configuración inicial, una sola vez:

1. En GitHub, ir a **Settings → Secrets and variables → Actions → New repository secret**.
2. Crear `MONGODB_URI` con la URI de producción (la misma de Vercel).
3. Crear `AUTH_SECRET` con el mismo secreto de producción. El script de
   limpieza no firma sesiones, pero `lib/env.ts` lo exige al conectar.
4. Hacer merge del workflow a `main`. GitHub solo programa workflows que están
   en la rama por defecto.

Para probarlo sin esperar al horario:

1. Ir a **Actions → Notifications cleanup → Run workflow**.
2. Marcar `dry_run` para contar huérfanos sin borrar.
3. Revisar el resumen y los logs del job.

Notas:

* El schedule de GitHub usa **UTC** y puede demorarse unos minutos si hay
  carga.
* En repositorios públicos, GitHub desactiva los workflows programados tras
  60 días sin actividad; se reactivan con un push o desde **Actions**.
* Si Atlas tiene IP allowlist, el runner de GitHub usa IPs dinámicas: hay que
  permitir el rango correspondiente o usar un self-hosted runner. La app ya
  se conecta desde Vercel, así que probablemente el acceso ya esté abierto.
* El job tiene `timeout-minutes: 30`. Si la colección es muy grande, se puede
  bajar el lote con `--batch-size=500` o ejecutar varias veces; el script es
  idempotente.

Recomendaciones operativas:

* Correr el cron después de la ventana de mayor uso y con la base accesible
  desde el mismo entorno que la app (usa `.env.local`).
* Revisar el log si `orphans` crece de forma sostenida: puede indicar que los
  TTL no están creados o que un flujo borra notificaciones sin sus estados.
* `--dry-run` es seguro para diagnóstico; no reemplaza al cron real.
* La limpieza no toca notificaciones ni estados de lectura válidos.

## 3. Paginación por cursor

`GET /api/users/notifications` y `GET /api/notifications` aceptan
`cursor` y `limit` (1–100, por defecto 30). El orden es
`{ createdAt: -1, _id: -1 }` y el cursor contiene ambos valores para no
repetir ni saltear documentos con el mismo `createdAt`.

El listado se resuelve con una aggregation:

1. `$match` de la bandeja y del cursor.
2. `$sort` por `createdAt/_id` (cubierto por índice).
3. `$lookup` del estado de lectura del usuario.
4. `$match` que descarta las notificaciones con `dismissedAt`.
5. `$limit` de `limit + 1` para calcular `hasMore`.

El paso 4 ocurre **antes** del `$limit`: si se limitara primero, una tanda de
notificaciones descartadas podría dejar la página vacía aunque existan
notificaciones no leídas más viejas.

## 4. Pruebas de escala y latencia

`scripts/test-notifications-scale.ts` usa MongoDB en memoria y siembra 10.000
notificaciones. Cubre:

* paginación por cursor sin duplicados;
* 60 descartadas al frente de la bandeja (la página nueva se completa; la
  implementación anterior devolvía 0);
* desempate por `_id` con `createdAt` repetidos;
* "marcar todas" con `$merge` y ventana de 90 días;
* limpieza de 2.000 estados huérfanos por lotes;
* índice TTL real en MongoDB.

Ejecutar solo esta prueba:

```bash
npm run test:notifications:scale
```

La salida incluye líneas `[notifications-scale]` con la latencia "antes"
(filtrar después del límite / upsert por id) y "después" (aggregation con
lookup / `$merge`). Los números son orientativos y dependen de la máquina y de
MongoDB; sirven para comparar la misma corrida, no como SLA.

Resultado de referencia en un equipo de desarrollo (MongoDB 8.2 local,
10.000 notificaciones, ventana de 90 días = 4.320 filas):

| Operación | Antes | Después |
| --- | --- | --- |
| Listado con 60 descartadas al frente | 0 visibles; 3,36 ms | 30 visibles; 19,57 ms |
| Marcar todas (4.320 filas) | 664 ms (4.320 upserts desde el proceso) | 628 ms (1 `$merge` en Mongo) |
| Limpieza de 2.000 huérfanos | — | 142 ms (22 lotes) |

Lectura: el listado "antes" era más rápido pero **incorrecto** (dejaba la
página vacía). El nuevo paga el `$lookup` para filtrar descartadas antes del
límite y devuelve la página completa. En "marcar todas" la latencia es
comparable, pero la diferencia importante es de memoria y acoplamiento: antes
el proceso cargaba todos los ids y armaba 4.320 operaciones; ahora Mongo hace
el trabajo con una sola aggregation y el proceso no retiene ids. La limpieza
recorre 22 lotes de 500 filas sin cargar la colección completa.
