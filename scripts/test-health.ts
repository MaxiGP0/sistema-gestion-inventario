/**
 * Pruebas del chequeo de salud de MongoDB (`getMongoHealth`):
 * conectado + ping ok, conexión rechazada, ping fallido y conexión que no
 * llega a estado "connected". No requiere una base real: se reemplazan las
 * propiedades de la conexión de mongoose.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { getMongoHealth } from '../app/api/health/route';

interface StubOptions {
  readyState: () => number;
  db?: () => unknown;
}

function stubConnection(options: StubOptions) {
  const connection = mongoose.connection as any;
  const hadReadyState = Object.prototype.hasOwnProperty.call(connection, 'readyState');
  const hadDb = Object.prototype.hasOwnProperty.call(connection, 'db');
  const previousReadyState = Object.getOwnPropertyDescriptor(connection, 'readyState');
  const previousDb = Object.getOwnPropertyDescriptor(connection, 'db');

  Object.defineProperty(connection, 'readyState', {
    configurable: true,
    get: options.readyState,
  });
  Object.defineProperty(connection, 'db', {
    configurable: true,
    get: options.db ?? (() => undefined),
  });

  return () => {
    if (hadReadyState && previousReadyState) {
      Object.defineProperty(connection, 'readyState', previousReadyState);
    } else {
      delete connection.readyState;
    }

    if (hadDb && previousDb) {
      Object.defineProperty(connection, 'db', previousDb);
    } else {
      delete connection.db;
    }
  };
}

before(() => {
  // Los fallos esperados se registran en el log estructurado; no ensuciar la salida.
  mock.method(console, 'error', () => {});
});

after(() => mock.restoreAll());

test('reporta connected cuando hay conexión y el ping responde', async () => {
  const ping = mock.fn(async () => ({ ok: 1 }));
  const restore = stubConnection({
    readyState: () => 1,
    db: () => ({ admin: () => ({ ping }) }),
  });

  try {
    const health = await getMongoHealth();

    assert.equal(health.status, 'connected');
    assert.equal(health.readyState, 1);
    assert.equal(health.error, undefined);
    assert.ok(health.latencyMs >= 0);
    assert.equal(ping.mock.callCount(), 1);
  } finally {
    restore();
  }
});

test('reporta connection-failed cuando no puede abrir la conexión', async () => {
  const restore = stubConnection({ readyState: () => 0 });

  try {
    const health = await getMongoHealth(async () => {
      throw new Error('Mongo no responde');
    });

    assert.equal(health.status, 'unavailable');
    assert.equal(health.readyState, 0);
    assert.equal(health.error, 'connection-failed');
  } finally {
    restore();
  }
});

test('reporta ping-failed cuando la conexión existe pero Mongo no responde', async () => {
  let readyState = 0;
  const restore = stubConnection({
    readyState: () => readyState,
    db: () => ({
      admin: () => ({
        ping: async () => {
          throw new Error('ping timeout');
        },
      }),
    }),
  });

  try {
    const health = await getMongoHealth(async () => {
      readyState = 1;
    });

    assert.equal(health.status, 'unavailable');
    assert.equal(health.readyState, 1);
    assert.equal(health.error, 'ping-failed');
  } finally {
    restore();
  }
});

test('reporta not-connected si el conector termina sin conexión', async () => {
  const restore = stubConnection({ readyState: () => 0 });

  try {
    const health = await getMongoHealth(async () => {
      // Simula un connect que resuelve sin dejar la conexión lista.
    });

    assert.equal(health.status, 'unavailable');
    assert.equal(health.readyState, 0);
    assert.equal(health.error, 'not-connected');
  } finally {
    restore();
  }
});
