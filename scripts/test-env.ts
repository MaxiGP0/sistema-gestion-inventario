/**
 * Pruebas de lib/env.ts: el schema Zod debe aceptar configuraciones válidas y
 * fallar con un mensaje que nombre la variable, sin filtrar su valor.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_SECRET_MIN_LENGTH, getEnv, parseEnv, resetEnvCache } from '../lib/env';

const VALID_URI = 'mongodb://127.0.0.1:27017/sgi-test';
const VALID_SECRET = 'secreto-de-prueba-1234567890';

test('acepta MongoDB local y Atlas con un secreto suficientemente largo', () => {
  const local = parseEnv({ MONGODB_URI: VALID_URI, AUTH_SECRET: VALID_SECRET });
  assert.equal(local.MONGODB_URI, VALID_URI);
  assert.equal(local.AUTH_SECRET, VALID_SECRET);

  const atlas = parseEnv({
    MONGODB_URI: 'mongodb+srv://usuario:clave@cluster.mongodb.net/sgi',
    AUTH_SECRET: VALID_SECRET,
  });
  assert.match(atlas.MONGODB_URI, /^mongodb\+srv:\/\//);
});

test('normaliza espacios alrededor de las variables', () => {
  const env = parseEnv({
    MONGODB_URI: `  ${VALID_URI}  `,
    AUTH_SECRET: `  ${VALID_SECRET}  `,
  });

  assert.equal(env.MONGODB_URI, VALID_URI);
  assert.equal(env.AUTH_SECRET, VALID_SECRET);
});

test('falla si falta MONGODB_URI', () => {
  assert.throws(
    () => parseEnv({ AUTH_SECRET: VALID_SECRET }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MONGODB_URI/);
      assert.match(error.message, /obligatoria/);
      return true;
    },
  );
});

test('falla si MONGODB_URI no tiene un esquema de MongoDB', () => {
  assert.throws(
    () => parseEnv({ MONGODB_URI: 'postgres://localhost/sgi', AUTH_SECRET: VALID_SECRET }),
    /MONGODB_URI debe empezar con mongodb:\/\//,
  );
});

test('falla si falta AUTH_SECRET o es demasiado corto', () => {
  assert.throws(() => parseEnv({ MONGODB_URI: VALID_URI }), /AUTH_SECRET es obligatoria/);

  assert.throws(
    () => parseEnv({ MONGODB_URI: VALID_URI, AUTH_SECRET: 'corto' }),
    new RegExp(`AUTH_SECRET debe tener al menos ${AUTH_SECRET_MIN_LENGTH} caracteres`),
  );
});

test('el mensaje de error no incluye el valor del secreto', () => {
  const secret = 'x7Q!corto';

  assert.throws(
    () => parseEnv({ MONGODB_URI: VALID_URI, AUTH_SECRET: secret }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret), 'el secreto no debe aparecer en el error');
      return true;
    },
  );
});

test('acepta Web Push configurado en bloque y lo deja disponible para envío', () => {
  const env = parseEnv({
    MONGODB_URI: VALID_URI,
    AUTH_SECRET: VALID_SECRET,
    VAPID_PUBLIC_KEY: '  "clave+publica/con=padding=="  ',
    VAPID_PRIVATE_KEY: "'clave+privada/con=padding='",
    VAPID_SUBJECT: 'mailto:push@example.com',
  });

  assert.equal(env.VAPID_PUBLIC_KEY, 'clave-publica_con=padding');
  assert.equal(env.VAPID_PRIVATE_KEY, 'clave-privada_con=padding');
  assert.equal(env.VAPID_SUBJECT, 'mailto:push@example.com');
});

test('Web Push es opcional: sin variables el resto del entorno sigue válido', () => {
  const env = parseEnv({ MONGODB_URI: VALID_URI, AUTH_SECRET: VALID_SECRET });

  assert.equal(env.VAPID_PUBLIC_KEY, undefined);
  assert.equal(env.VAPID_PRIVATE_KEY, undefined);
  assert.equal(env.VAPID_SUBJECT, undefined);
});

test('rechaza una configuración VAPID parcial indicando la variable faltante', () => {
  assert.throws(
    () =>
      parseEnv({
        MONGODB_URI: VALID_URI,
        AUTH_SECRET: VALID_SECRET,
        VAPID_PUBLIC_KEY: 'clave-publica',
        VAPID_PRIVATE_KEY: 'clave-privada',
      }),
    /VAPID_SUBJECT es obligatoria cuando se configura Web Push/,
  );

  assert.throws(
    () =>
      parseEnv({
        MONGODB_URI: VALID_URI,
        AUTH_SECRET: VALID_SECRET,
        VAPID_SUBJECT: 'mailto:push@example.com',
      }),
    /VAPID_PUBLIC_KEY es obligatoria cuando se configura Web Push/,
  );
});

test('rechaza un VAPID_SUBJECT que no sea mailto: ni https:', () => {
  assert.throws(
    () =>
      parseEnv({
        MONGODB_URI: VALID_URI,
        AUTH_SECRET: VALID_SECRET,
        VAPID_PUBLIC_KEY: 'clave-publica',
        VAPID_PRIVATE_KEY: 'clave-privada',
        VAPID_SUBJECT: 'push@example.com',
      }),
    /VAPID_SUBJECT debe ser un mailto: o una URL https:/,
  );
});

test('getEnv cachea la validación hasta resetEnvCache', () => {
  const originalUri = process.env.MONGODB_URI;
  const originalSecret = process.env.AUTH_SECRET;

  try {
    process.env.MONGODB_URI = VALID_URI;
    process.env.AUTH_SECRET = VALID_SECRET;
    resetEnvCache();

    const first = getEnv();
    process.env.AUTH_SECRET = 'otro-secreto-suficientemente-largo';
    assert.equal(getEnv().AUTH_SECRET, first.AUTH_SECRET, 'debe devolver el valor cacheado');

    resetEnvCache();
    assert.equal(getEnv().AUTH_SECRET, 'otro-secreto-suficientemente-largo');
  } finally {
    if (originalUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalUri;

    if (originalSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalSecret;

    resetEnvCache();
  }
});
