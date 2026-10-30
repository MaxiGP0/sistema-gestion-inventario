import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { E2E_MONGODB_URI, E2E_MONGO_PORT, E2E_USE_EXTERNAL_MONGODB } from './config';
import { seedE2EDatabase } from '../scripts/seed-e2e';

/**
 * Arranca la base efímera (salvo que se use un Mongo externo) y siembra los
 * datos de prueba antes de que Playwright levante el servidor de Next.
 *
 * Playwright llama a la función devuelta al terminar la suite, así el proceso
 * de mongod no queda vivo entre corridas.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  // El seed recrea los ObjectIds de clientes, marcas y productos. La caché
  // persistente de Next (`use cache`/`cacheTag`) sobrevive entre corridas y
  // podría servir el HTML del alta con ids del seed anterior. En Next 16 el
  // servidor de desarrollo usa `.next/dev/cache`, así que se limpian ambas
  // variantes antes de que arranque el webServer.
  for (const cacheDir of ['cache', join('dev', 'cache')]) {
    rmSync(join(process.cwd(), '.next', cacheDir), { recursive: true, force: true });
  }

  let mongo: MongoMemoryServer | undefined;

  if (!E2E_USE_EXTERNAL_MONGODB) {
    mongo = await MongoMemoryServer.create({
      instance: {
        port: E2E_MONGO_PORT,
        dbName: 'sgi-e2e',
      },
    });
    console.log(`[e2e] MongoDB efímero escuchando en el puerto ${E2E_MONGO_PORT}.`);
  }

  try {
    await seedE2EDatabase(E2E_MONGODB_URI);
  } catch (error) {
    await mongo?.stop();
    throw error;
  }

  if (!mongo) return;

  return async () => {
    await mongo?.stop();
  };
}
