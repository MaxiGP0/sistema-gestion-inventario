/**
 * Configuración compartida por Playwright, el setup global y los tests.
 *
 * Por defecto los E2E levantan una instancia efímera de MongoDB en el puerto
 * 27019 y una base `sgi-e2e`, así que no hacen falta servicios externos.
 * Para usar un Mongo ya existente:
 *
 *   E2E_USE_EXTERNAL_MONGODB=1 E2E_MONGODB_URI=mongodb://.../sgi-e2e npm run test:e2e
 *
 * El seed se niega a ejecutarse si el nombre de la base no contiene "e2e" o
 * "test", para no pisar datos de desarrollo o producción por accidente.
 */

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;

export const E2E_MONGO_PORT = Number(process.env.E2E_MONGO_PORT ?? 27019);
export const E2E_MONGODB_URI =
  process.env.E2E_MONGODB_URI ?? `mongodb://127.0.0.1:${E2E_MONGO_PORT}/sgi-e2e`;
export const E2E_USE_EXTERNAL_MONGODB = process.env.E2E_USE_EXTERNAL_MONGODB === '1';

export const E2E_AUTH_SECRET = process.env.E2E_AUTH_SECRET ?? 'e2e-auth-secret-sgi-0123456789';
