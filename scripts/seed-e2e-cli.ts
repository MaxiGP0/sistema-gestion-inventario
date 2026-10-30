import dotenv from 'dotenv';
import { seedE2EDatabase } from './seed-e2e';

/**
 * CLI del seed E2E para un Mongo de prueba ya levantado:
 *
 *   E2E_MONGODB_URI=mongodb://127.0.0.1:27019/sgi-e2e npm run seed:e2e
 *
 * La suite de Playwright no usa este archivo: llama directamente a
 * `seedE2EDatabase` desde `e2e/global-setup.ts`.
 */

dotenv.config({ path: '.env.local' });

const uri = process.env.E2E_MONGODB_URI || 'mongodb://127.0.0.1:27019/sgi-e2e';

seedE2EDatabase(uri)
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[e2e] Error durante el seed:', error);
    process.exit(1);
  });
