import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import type { Model } from 'mongoose';
import dbConnect from '../lib/mongodb';
import { Client } from '../models/Client';
import { Order } from '../models/Order';
import { Product } from '../models/Product';

/**
 * Migración única de los índices de las consultas calientes:
 *
 * - Order:   { archived: 1, createdAt: -1, _id: -1 }
 * - Client:  { name: 1, _id: 1 }
 * - Product: { brandId: 1, name: 1, active: 1 } y { name: 1, active: 1 }
 *
 * `syncIndexes()` crea los nuevos y elimina los índices que el schema ya no
 * declara. Es idempotente.
 *
 * Ejecutar una sola vez:
 *   npx tsx scripts/migrate-query-indexes.ts
 */

const MODELS: [string, Model<any>][] = [
  ['orders', Order],
  ['clients', Client],
  ['products', Product],
];

async function migrate() {
  try {
    console.log('Conectando a MongoDB...');
    await dbConnect();
    console.log('¡Conectado exitosamente!');

    for (const [label, model] of MODELS) {
      // En una base nueva el namespace todavía no existe; syncIndexes() lo crea.
      const before = (
        await model.collection.indexes().catch((error: any) => {
          if (error?.codeName === 'NamespaceNotFound') return [];
          throw error;
        })
      )
        .map((index: { name?: string }) => index.name)
        .filter(Boolean);
      const removed = await model.syncIndexes();
      const after = (await model.collection.indexes()).map((index) => index.name).filter(Boolean);

      console.log(`\n${label}:`);
      console.log(`  antes: ${before.join(', ') || 'ninguno'}`);
      console.log(`  eliminados: ${removed.join(', ') || 'ninguno'}`);
      console.log(`  después: ${after.join(', ') || 'ninguno'}`);
    }

    console.log('\n¡Migración completada exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('Error durante la migración:', error);
    process.exit(1);
  }
}

migrate();
