import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import dbConnect from '../lib/mongodb';
import { Order } from '../models/Order';

/**
 * Migración única: reemplaza los índices de listado de `orders` por sus
 * equivalentes con `_id: -1`.
 *
 * Los listados de depósito/facturación ahora pagan con cursor
 * `{ createdAt: -1, _id: -1 }`. Para que Mongo resuelva el filtro y el orden
 * sin una etapa de sort en memoria, el desempate por `_id` debe formar parte
 * de los índices. `syncIndexes()` crea los nuevos y elimina los viejos.
 *
 * Ejecutar una sola vez:
 *   npx tsx scripts/migrate-order-cursor-indexes.ts
 */

async function migrate() {
  try {
    console.log('Conectando a MongoDB...');
    await dbConnect();
    console.log('¡Conectado exitosamente!');

    const before = (await Order.collection.indexes()).map((index) => index.name).filter(Boolean);
    const removed = await Order.syncIndexes();
    const after = (await Order.collection.indexes()).map((index) => index.name).filter(Boolean);

    console.log(`Índices antes: ${before.join(', ') || 'ninguno'}`);
    console.log(`Índices eliminados: ${removed.join(', ') || 'ninguno'}`);
    console.log(`Índices después: ${after.join(', ') || 'ninguno'}`);
    console.log('¡Migración completada exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('Error durante la migración:', error);
    process.exit(1);
  }
}

migrate();
