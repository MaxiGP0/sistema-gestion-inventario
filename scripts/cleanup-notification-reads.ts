import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import dbConnect from '../lib/mongodb';
import { cleanupOrphanNotificationReads } from '../lib/notification-retention';

/**
 * Borra filas de `NotificationRead` cuyo `notificationId` ya no existe.
 *
 * Las notificaciones se eliminan por retención TTL (180 días) o al hacer
 * hard-delete de un pedido. Este script es idempotente y está pensado para un
 * cron diario. Ver docs/notificaciones-retencion.md.
 *
 * Uso:
 *   npx tsx scripts/cleanup-notification-reads.ts --dry-run
 *   npx tsx scripts/cleanup-notification-reads.ts --batch-size=1000
 *
 * Salida: un JSON con scanned/orphans/deleted/batches/durationMs.
 */

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  return (
    process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ??
    (process.argv.includes(`--${name}`)
      ? process.argv[process.argv.indexOf(`--${name}`) + 1]
      : undefined)
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = Number(readOption('batch-size') ?? 1000);
  const maxBatches = Number(readOption('max-batches') ?? 0);

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    console.error('--batch-size debe ser un entero mayor a 0');
    process.exit(1);
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 0) {
    console.error('--max-batches debe ser un entero mayor o igual a 0');
    process.exit(1);
  }

  try {
    console.log('Conectando a MongoDB...');
    await dbConnect();

    const result = await cleanupOrphanNotificationReads({
      batchSize,
      dryRun,
      maxBatches,
      onBatch: (progress) => {
        console.log(
          `Lote ${progress.batch}: ${progress.scanned} leídos, ${progress.orphans} huérfanos, ${progress.deleted} borrados`,
        );
      },
    });

    console.log(JSON.stringify({ ...result, batchSize, maxBatches }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error limpiando NotificationRead huérfanos:', error);
    process.exit(1);
  }
}

void main();
