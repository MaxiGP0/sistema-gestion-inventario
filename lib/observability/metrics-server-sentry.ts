/**
 * Sink de métricas para el servidor (Node/Edge).
 *
 * Importa Sentry de forma estática porque solo lo usa `instrumentation.ts`, que
 * corre en el servidor. Se registra después de `Sentry.init`.
 */

import * as Sentry from '@sentry/nextjs';
import type { MetricsSink } from './metrics';

export const serverSentryMetricsSink: MetricsSink = {
  count(name, value = 1, options) {
    Sentry.metrics.count(name, value, options);
  },
  gauge(name, value, options) {
    Sentry.metrics.gauge(name, value, options);
  },
  distribution(name, value, options) {
    Sentry.metrics.distribution(name, value, options);
  },
};
