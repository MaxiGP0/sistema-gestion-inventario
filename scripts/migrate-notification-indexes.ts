import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import dbConnect from '../lib/mongodb';
import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';

/**
 * Migración de índices de notificaciones:
 * - reemplaza los índices de listado por sus equivalentes con `_id: -1`
 *   (paginación por cursor `{ createdAt: -1, _id: -1 }`);
 * - crea el índice TTL de retención de 180 días;
 * - asegura el índice único `{ userId, notificationId }` de NotificationRead,
 *   que `$merge` usa para el upsert masivo de "marcar todas".
 *
 * `syncIndexes()` crea los declarados en el schema y elimina los que ya no
 * existen. Es idempotente: se puede correr más de una vez.
 *
 * Ejecutar una vez por entorno:
 *   npx tsx scripts/migrate-notification-indexes.ts
 */
async function migrate() {
  try {
    console.log('Conectando a MongoDB...');
    await dbConnect();
    console.log('¡Conectado exitosamente!');

    const before = (await Notification.collection.indexes())
      .map((index) => index.name)
      .filter(Boolean);
    const removed = await Notification.syncIndexes();
    const after = (await Notification.collection.indexes())
      .map((index) => index.name)
      .filter(Boolean);

    const removedReads = await NotificationRead.syncIndexes();
    const reads = (await NotificationRead.collection.indexes())
      .map((index) => index.name)
      .filter(Boolean);

    console.log(`Índices de Notification antes: ${before.join(', ') || 'ninguno'}`);
    console.log(`Índices de Notification eliminados: ${removed.join(', ') || 'ninguno'}`);
    console.log(`Índices de Notification después: ${after.join(', ') || 'ninguno'}`);
    console.log(`Índices de NotificationRead eliminados: ${removedReads.join(', ') || 'ninguno'}`);
    console.log(`Índices de NotificationRead después: ${reads.join(', ') || 'ninguno'}`);
    console.log('¡Migración completada exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('Error durante la migración:', error);
    process.exit(1);
  }
}

void migrate();
