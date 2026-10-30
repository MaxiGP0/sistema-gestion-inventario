/**
 * Limpieza de estados de lectura huérfanos.
 *
 * La retención TTL de `Notification` (180 días) y el hard-delete de pedidos
 * pueden borrar notificaciones sin borrar sus filas de `NotificationRead`. Este
 * módulo las detecta en lotes ordenados por `_id` para no cargar la colección
 * completa en memoria.
 *
 * No se usa un `$lookup` global: se recorre `NotificationRead` por cursor de
 * `_id` y, por cada lote, se consulta qué notificaciones siguen existiendo con
 * un único `$in` sobre `_id`. Así el costo es lineal y la memoria queda acotada
 * por `batchSize`.
 */
import type { Types } from 'mongoose';
import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';

export interface NotificationReadCleanupOptions {
  /** Cantidad de estados leídos por lote. */
  batchSize?: number;
  /** Si es `true`, cuenta huérfanos pero no borra nada. */
  dryRun?: boolean;
  /** Límite opcional de lotes (útil para pruebas o ejecuciones acotadas). */
  maxBatches?: number;
  /** Callback de progreso por lote. */
  onBatch?: (progress: NotificationReadCleanupProgress) => void;
}

export interface NotificationReadCleanupProgress {
  batch: number;
  scanned: number;
  orphans: number;
  deleted: number;
}

export interface NotificationReadCleanupResult {
  scanned: number;
  orphans: number;
  deleted: number;
  batches: number;
  dryRun: boolean;
  durationMs: number;
}

const DEFAULT_BATCH_SIZE = 1_000;

export async function cleanupOrphanNotificationReads({
  batchSize = DEFAULT_BATCH_SIZE,
  dryRun = false,
  maxBatches = 0,
  onBatch,
}: NotificationReadCleanupOptions = {}): Promise<NotificationReadCleanupResult> {
  const startedAt = Date.now();
  const size = Math.max(1, Math.trunc(batchSize));

  let lastId: Types.ObjectId | undefined;
  let scanned = 0;
  let orphans = 0;
  let deleted = 0;
  let batches = 0;

  for (;;) {
    if (maxBatches > 0 && batches >= maxBatches) break;

    const query = lastId ? { _id: { $gt: lastId } } : {};
    const reads = await NotificationRead.find(query)
      .sort({ _id: 1 })
      .limit(size)
      .select('_id notificationId')
      .lean();

    if (reads.length === 0) break;

    const notificationIds = reads.map((read) => read.notificationId);
    const existing = await Notification.distinct('_id', { _id: { $in: notificationIds } });
    const existingIds = new Set(existing.map((id) => String(id)));

    const orphanIds = reads
      .filter((read) => !existingIds.has(String(read.notificationId)))
      .map((read) => read._id);

    scanned += reads.length;
    orphans += orphanIds.length;
    batches += 1;

    if (!dryRun && orphanIds.length > 0) {
      const result = await NotificationRead.deleteMany({ _id: { $in: orphanIds } });
      deleted += result.deletedCount ?? 0;
    }

    onBatch?.({ batch: batches, scanned, orphans, deleted });

    lastId = reads[reads.length - 1]._id as Types.ObjectId;
    if (reads.length < size) break;
  }

  return {
    scanned,
    orphans,
    deleted,
    batches,
    dryRun,
    durationMs: Date.now() - startedAt,
  };
}
