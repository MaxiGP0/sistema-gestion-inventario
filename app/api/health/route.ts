import mongoose from 'mongoose';
import { connection, NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { logError, withRouteLogging } from '@/lib/logger';
import { captureHealthFailure } from '@/lib/observability/errors-server';
import { recordMongoError, recordMongoHealth } from '@/lib/observability/metrics';
import type { HealthResponse, MongoHealthCheck } from '@/lib/types';

type MongoConnector = () => Promise<unknown>;

/**
 * Comprueba la conexión actual y, si todavía no existe, intenta abrirla.
 * El `ping` confirma que la conexión sigue viva, no solo que mongoose tenga
 * una referencia guardada.
 */
export async function getMongoHealth(
  connect: MongoConnector = dbConnect,
): Promise<MongoHealthCheck> {
  const startedAt = Date.now();
  let readyState = mongoose.connection.readyState;

  if (readyState !== 1) {
    try {
      await connect();
      readyState = mongoose.connection.readyState;
    } catch (error) {
      logError('health.mongodb.connection_failed', error, { readyState });
      const latencyMs = Date.now() - startedAt;
      recordMongoError({
        operation: 'health.connection',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      recordMongoHealth({
        status: 'unavailable',
        readyState: mongoose.connection.readyState,
        latencyMs,
        error: 'connection-failed',
      });
      return {
        status: 'unavailable',
        readyState: mongoose.connection.readyState,
        latencyMs,
        error: 'connection-failed',
      };
    }
  }

  if (readyState !== 1) {
    const latencyMs = Date.now() - startedAt;
    recordMongoError({
      operation: 'health.connection',
      errorName: 'not-connected',
    });
    recordMongoHealth({
      status: 'unavailable',
      readyState,
      latencyMs,
      error: 'not-connected',
    });
    return {
      status: 'unavailable',
      readyState,
      latencyMs,
      error: 'not-connected',
    };
  }

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Mongoose está conectado pero no expone una base de datos');
    }

    await db.admin().ping();

    const latencyMs = Date.now() - startedAt;
    recordMongoHealth({ status: 'connected', readyState, latencyMs });

    return {
      status: 'connected',
      readyState,
      latencyMs,
    };
  } catch (error) {
    logError('health.mongodb.ping_failed', error, { readyState });
    const latencyMs = Date.now() - startedAt;
    recordMongoError({
      operation: 'health.ping',
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    recordMongoHealth({
      status: 'unavailable',
      readyState,
      latencyMs,
      error: 'ping-failed',
    });
    return {
      status: 'unavailable',
      readyState,
      latencyMs,
      error: 'ping-failed',
    };
  }
}

/**
 * GET /api/health
 *
 * Endpoint público para probes de disponibilidad. Responde 200 cuando Mongo
 * responde al ping y 503 cuando no. No expone URI, credenciales ni detalles
 * internos: eso queda en el log estructurado de la ruta.
 */
export const GET = withRouteLogging(async () => {
  // Con Cache Components, connection() garantiza que el chequeo se ejecute
  // en cada request y no durante el prerender del build.
  await connection();

  const mongodb = await getMongoHealth();
  const healthy = mongodb.status === 'connected';

  if (!healthy) {
    captureHealthFailure({
      reason: mongodb.error ?? 'unknown',
      readyState: mongodb.readyState,
      latencyMs: mongodb.latencyMs,
    });
  }

  const body: HealthResponse = {
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: { mongodb },
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
});
