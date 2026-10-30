/**
 * Hook de arranque de Next.js.
 *
 * 1. Valida la configuración del servidor antes de aceptar peticiones. Si
 *    falta MONGODB_URI o AUTH_SECRET (o tienen un formato inválido), el proceso
 *    falla con un mensaje que indica la variable exacta.
 * 2. Inicializa Sentry en el runtime correspondiente (Node o Edge) y registra
 *    el sink de métricas del servidor.
 * 3. Reporta errores no atrapados con `onRequestError`, correlacionándolos con
 *    el `x-request-id` que propaga `proxy.ts`.
 */

import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getEnv } = await import('./lib/env');
    getEnv();
    await import('./sentry.server.config');
    const { setMetricsSink } = await import('./lib/observability/metrics');
    const { serverSentryMetricsSink } = await import('./lib/observability/metrics-server-sentry');
    setMetricsSink(serverSentryMetricsSink);
    return;
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
    const { setMetricsSink } = await import('./lib/observability/metrics');
    const { serverSentryMetricsSink } = await import('./lib/observability/metrics-server-sentry');
    setMetricsSink(serverSentryMetricsSink);
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { captureRequestError } = await import('./lib/observability/errors-server');
  await captureRequestError(error, request, context);
};
