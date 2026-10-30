import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import dbConnect from '../lib/mongodb';
import { backfillSearchFields, syncSearchIndexes } from '../lib/search-backfill';

/**
 * Migración idempotente de las búsquedas de clientes, productos, marcas y
 * pedidos.
 *
 * 1. Rellena `searchName`/`searchCode`/`searchLocalidad`/`searchProvince`/
 *    `searchAddress` (minúsculas, sin acentos) y el array multikey
 *    `searchTokens` con las palabras únicas de esos campos en los documentos
 *    existentes. En pedidos completa además `shortId` y suma cliente, vendedor,
 *    código corto e ítems al array. Sólo escribe los campos que cambiaron, por
 *    lotes.
 * 2. Ejecuta `syncIndexes()` para crear los índices de prefijo/multikey y
 *    eliminar los índices legacy que el schema ya no declara (incluido
 *    `order_search_text`).
 *
 * Se puede ejecutar las veces que haga falta: la segunda corrida no modifica
 * documentos ni índices. Antes de correrla en producción conviene probar con
 * `--dry-run`, que cuenta los cambios sin escribir ni tocar índices.
 *
 * Uso:
 *   npx tsx scripts/migrate-search-fields.ts --dry-run
 *   npx tsx scripts/migrate-search-fields.ts
 *   npx tsx scripts/migrate-search-fields.ts --batch-size=1000
 */

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchSizeArg = args.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1];
const batchSize = Math.max(1, Number(batchSizeArg) || 500);

async function migrate() {
  try {
    console.log('Conectando a MongoDB...');
    await dbConnect();
    console.log(dryRun ? '¡Conectado! Modo simulación (--dry-run).' : '¡Conectado exitosamente!');

    await backfillSearchFields({
      dryRun,
      batchSize,
      onCollection: ({ label, scanned, changed }) => {
        console.log(
          `${label}: ${scanned} documento(s) revisado(s), ${changed} con cambios` +
            (dryRun ? ' (simulación, no se escribió nada).' : '.'),
        );
      },
    });

    if (dryRun) {
      console.log('\nSimulación completada: no se crearon índices ni se modificaron documentos.');
      process.exit(0);
    }

    for (const { label, before, removed, after } of await syncSearchIndexes()) {
      console.log(`\n${label}:`);
      console.log(`  índices antes: ${before.join(', ') || 'ninguno'}`);
      console.log(`  índices eliminados: ${removed.join(', ') || 'ninguno'}`);
      console.log(`  índices después: ${after.join(', ') || 'ninguno'}`);
    }

    console.log('\n¡Migración completada exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('Error durante la migración:', error);
    process.exit(1);
  }
}

void migrate();
