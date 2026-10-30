/**
 * Sink de métricas para el navegador.
 *
 * Las métricas se encolan hasta que `sentry-client` termina de cargar el SDK
 * (o se descartan sin DSN), así el bundle inicial no incluye Sentry.
 */

import type { MetricsSink } from './metrics';
import { withClientSentry } from './sentry-client';

export const clientSentryMetricsSink: MetricsSink = {
  count(name, value = 1, options) {
    withClientSentry((Sentry) => Sentry.metrics.count(name, value, options));
  },
  gauge(name, value, options) {
    withClientSentry((Sentry) => Sentry.metrics.gauge(name, value, options));
  },
  distribution(name, value, options) {
    withClientSentry((Sentry) => Sentry.metrics.distribution(name, value, options));
  },
};
