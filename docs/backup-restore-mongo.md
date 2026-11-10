# Backup, restore y retención de MongoDB

Este runbook cubre cómo respaldar y restaurar la base del Sistema de Gestión de Inventario, cómo verificar
una restauración y qué retención aplicar. Aplica a MongoDB local y a MongoDB
Atlas; para producción se recomienda **Atlas con backup continuo/PITR** y,
además, un backup lógico periódico con `mongodump` para exportación y pruebas de
restauración.

## 1. Objetivos

| Concepto | Valor sugerido |
| --- | --- |
| RPO (pérdida máxima de datos) | 15 minutos con PITR de Atlas; 24 horas con dump diario |
| RTO (tiempo de recuperación) | < 2 horas para una restauración completa |
| Retención de backups | 7 diarios + 4 semanales + 12 mensuales |
| Prueba de restauración | Trimestral, en una base temporal |
| Cifrado | En reposo (Atlas/KMS) y en tránsito; backups externos cifrados |

La base contiene pedidos, clientes, productos, usuarios y notificaciones. Los
backups son **datos confidenciales**: no se suben a repositorios, no se envían
por chat y no se incluyen en logs.

## 2. Herramientas

- **Atlas**: Backup continuo (PITR) o snapshots programados desde el panel.
- **MongoDB Database Tools**: `mongodump`, `mongorestore`, `mongosh`.
- **Cifrado**: `age` o `gpg` para backups fuera de Atlas.
- **Almacenamiento**: bucket con versionado, cifrado y, si es posible,
  object lock/WORM. No usar el disco de la app como único destino.

Instalación de las herramientas (ejemplos):

```bash
# Debian/Ubuntu: agregar el repositorio oficial de MongoDB Database Tools y luego
sudo apt-get install -y mongodb-database-tools

# macOS
brew install mongodb-database-tools

# Windows: descargar MongoDB Database Tools y agregar bin al PATH
mongodump --version
```

La versión de las herramientas debe ser compatible con la versión del servidor
MongoDB. Antes de un restore, confirmar `mongodump --version` y la versión de
Atlas.

## 3. Backup lógico con `mongodump`

### 3.1 Backup diario (Linux/macOS)

```bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/sgi}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

# MONGODB_URI debe venir del entorno/secret manager, nunca del historial.
mongodump \
  --uri="$MONGODB_URI" \
  --gzip \
  --archive="$BACKUP_DIR/sgi-$STAMP.archive.gz"

# Verificación básica de que el archivo existe y no está vacío.
test -s "$BACKUP_DIR/sgi-$STAMP.archive.gz"
```

Para una copia consistente en un replica set (Atlas lo es), agregar el oplog:

```bash
mongodump \
  --uri="$MONGODB_URI" \
  --gzip \
  --oplog \
  --archive="$BACKUP_DIR/sgi-$STAMP-oplog.archive.gz"
```

`--oplog` requiere un replica set. En un standalone, detener las escrituras de
la app durante el dump o aceptar una copia no transaccional.

### 3.2 Backup diario (PowerShell)

```powershell
$ErrorActionPreference = "Stop"
$backupDir = "D:\backups\sgi"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

mongodump --uri="$env:MONGODB_URI" --gzip --archive="$backupDir\sgi-$stamp.archive.gz"
if (-not (Test-Path "$backupDir\sgi-$stamp.archive.gz")) { throw "Backup vacío" }
```

### 3.3 Cifrado y destino externo

```bash
# Cifrar con age (la clave pública va en el secret manager)
age -r "$AGE_RECIPIENT" \
  -o "$BACKUP_DIR/sgi-$STAMP.archive.gz.age" \
  "$BACKUP_DIR/sgi-$STAMP.archive.gz"

# Subir al bucket con versionado. El comando depende del proveedor (aws s3, gcloud, az).
aws s3 cp "$BACKUP_DIR/sgi-$STAMP.archive.gz.age" \
  "s3://sgi-backups/mongo/$(date -u +%Y/%m)/"
```

Buenas prácticas:

- El bucket debe tener cifrado, versionado y retención/object lock.
- El usuario de backup solo necesita `read` sobre la base y `write` sobre el
  bucket.
- Rotar credenciales y no reutilizar la URI de la app para tareas manuales.
- Guardar el checksum (`sha256sum`) junto al archivo para detectar corrupción.

### 3.4 Programación

Linux (crontab), todos los días a las 02:30 UTC. Guardar el bloque de la sección
3.1 como `/usr/local/bin/sgi-backup.sh` (con permisos 700) y programarlo:

```cron
30 2 * * * /usr/bin/flock -n /tmp/sgi-backup.lock /usr/local/bin/sgi-backup.sh >> /var/log/sgi-backup.log 2>&1
```

Windows (Programador de tareas): ejecutar el bloque de PowerShell anterior con
una cuenta de servicio y registrar la salida en un archivo. Verificar
`Resultado: 0x0` y que el archivo tenga tamaño razonable.

En Atlas, además del dump lógico, configurar **Cloud Backup**:

1. **Atlas → Project → Backup → Backup Settings**.
2. Elegir snapshot schedule (por ejemplo cada 6 horas) y retención.
3. Habilitar **Point-in-Time Restore** si el plan lo permite.
4. Configurar alertas de fallo de backup y revisar el estado semanalmente.

## 4. Restauración

### 4.1 Restaurar a una base temporal (siempre primero)

Nunca restaurar directamente sobre producción para “probar”. Usar otra base:

```bash
STAMP="20261024T023000Z"
ARCHIVE="/var/backups/sgi/sgi-$STAMP.archive.gz"

mongorestore \
  --uri="$MONGODB_URI" \
  --gzip \
  --archive="$ARCHIVE" \
  --nsFrom='sgi.*' \
  --nsTo='sgi_restore.*'
```

Verificar:

```bash
mongosh "$MONGODB_URI/sgi_restore" --eval '
  printjson({
    orders: db.orders.countDocuments(),
    clients: db.clients.countDocuments(),
    products: db.products.countDocuments(),
    users: db.users.countDocuments(),
    notifications: db.notifications.countDocuments()
  });
  printjson(db.orders.getIndexes());
'
```

Comparar con producción (solo conteos, sin exportar documentos) y probar la app
apuntando `MONGODB_URI` a `sgi_restore` en un entorno de staging. Si todo
está bien, borrar la base temporal:

```bash
mongosh "$MONGODB_URI/sgi_restore" --eval 'db.dropDatabase()'
```

### 4.2 Restauración completa con ventana de mantenimiento

1. Avisar la ventana y detener la app (o ponerla en modo mantenimiento) para
   evitar escrituras durante el restore.
2. Hacer un **backup del estado actual** antes de tocar nada, aunque esté
   degradado. Puede servir para recuperar datos posteriores.
3. Elegir el punto de restauración: snapshot/PITR de Atlas o dump lógico.
4. Restaurar con `--drop` y limitar el namespace:

```bash
mongorestore \
  --uri="$MONGODB_URI" \
  --gzip \
  --archive="$ARCHIVE" \
  --drop \
  --nsInclude='sgi.*'
```

`--drop` elimina las colecciones que también están en el dump antes de
recrearlas. No elimina colecciones que no estén en el dump; si se necesita un
estado exacto, evaluar `db.dropDatabase()` **después** de un backup verificado.

5. Revisar índices y TTL:

```bash
mongosh "$MONGODB_URI/sgi" --eval '
  printjson(db.notifications.getIndexes());
  printjson(db.orders.getIndexes());
'
```

Debe existir `notification_retention_ttl` con `expireAfterSeconds: 15552000`.
Si faltan índices, correr los scripts de migración correspondientes
(`npm run notifications:migrate-indexes`, scripts de búsqueda/índices).

6. Arrancar la app, verificar `/api/health` y hacer un smoke test:

```bash
curl -i https://<host>/api/health
# Login con un usuario de prueba, listar pedidos, abrir un pedido y confirmar
# que las notificaciones y el dashboard cargan.
```

7. Confirmar que las escrituras nuevas funcionan (crear un pedido de prueba en
   staging, no en producción si no corresponde).
8. Documentar el incidente: hora, backup usado, duración, conteos antes/después
   y cualquier pérdida de datos.

### 4.3 Restauración con Atlas PITR

1. **Atlas → Backup → Restore / Point in Time**.
2. Elegir el instante anterior al incidente (por ejemplo, 5 minutos antes).
3. Restaurar en un **cluster nuevo** (no sobrescribir el actual).
4. Validar con `mongosh` y con un entorno de staging apuntando al cluster nuevo.
5. Cambiar `MONGODB_URI` en el secret manager de la app y reiniciar.
6. Mantener el cluster anterior detenido unos días por si hace falta comparar;
   luego eliminarlo según la política de retención.

Durante el PITR no debe haber escrituras en el cluster destino. Si el incidente
fue un borrado accidental, restaurar a un cluster aparte evita perder los datos
nuevos que puedan haber llegado después.

### 4.4 Restauración puntual de una colección

Para recuperar solo una colección (por ejemplo `orders`) sin tocar el resto:

```bash
mongorestore \
  --uri="$MONGODB_URI" \
  --gzip \
  --archive="$ARCHIVE" \
  --nsFrom='sgi.orders' \
  --nsTo='sgi_restore.orders'

# Copiar los documentos necesarios con mongosh, con un filtro acotado y
# verificando antes en sgi_restore. No hacer un replace masivo sin backup.
```

## 5. Retención

| Dato | Retención | Implementación |
| --- | --- | --- |
| Backups diarios | 7 días | Bucket/Atlas lifecycle |
| Backups semanales | 4 semanas | Regla de lifecycle |
| Backups mensuales | 12 meses | Regla de lifecycle/object lock |
| Backups de fin de año | Según obligación fiscal | Acordar con negocio |
| Logs de la app | 30 días | Rotación/plataforma de logs |
| Sentry (errores/traces/métricas) | 30–90 días | Plan de Sentry |
| Notificaciones | 180 días | TTL `notification_retention_ttl` |
| `NotificationRead` huérfanos | Diario | `npm run notifications:cleanup` |
| Pedidos y facturación | Recomendado 5 años | Sin TTL; definir con negocio/legal |

Referencias:

- Notificaciones: [`docs/notificaciones-retencion.md`](./notificaciones-retencion.md).
- Observabilidad: [`docs/observabilidad.md`](./observabilidad.md).

### Limpieza de backups

Automatizar la expiración por lifecycle del bucket; no borrar a mano sin revisar
la fecha. Mantener al menos:

- 7 copias diarias verificadas;
- 4 copias semanales;
- 12 copias mensuales;
- una copia inmutable (object lock) por trimestre si el proveedor lo permite.

Un backup que nunca se restauró no es un backup confiable: hacer una prueba
trimestral en una base temporal y registrar el resultado.

## 6. Checklist de verificación

Antes de dar por válido un backup:

- [ ] El archivo existe y no está vacío.
- [ ] El checksum coincide con el registrado.
- [ ] Se restauró en una base temporal sin errores.
- [ ] Los conteos de colecciones son razonables.
- [ ] Los índices y TTL están presentes.
- [ ] La app arranca contra la base restaurada y `/api/health` responde 200.
- [ ] Login y lectura de un pedido funcionan.
- [ ] El backup está cifrado y el acceso quedó auditado.

## 7. Errores comunes

- **`mongorestore` se queda sin memoria**: restaurar por colección o usar un
  host con más recursos; no interrumpir a mitad de una colección.
- **Faltan índices**: el dump no siempre incluye índices si se usó
  `--noIndexRestore`; revisar y recrear con los scripts del proyecto.
- **TTL ausente**: ejecutar la migración de índices de notificaciones.
- **La app apunta a la base equivocada**: validar `MONGODB_URI` en el secret
  manager y en el entorno de ejecución, no solo en `.env.local`.
- **Credenciales en logs**: nunca imprimir la URI; el logger ya redacta claves
  sensibles, pero la URI debe tratarse como secreto.
- **Restore sobre producción sin backup previo**: no hacerlo; primero respaldar
  el estado actual y restaurar en un cluster/base temporal.
