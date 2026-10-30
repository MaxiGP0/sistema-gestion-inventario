'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { recordWebVital } from '@/lib/observability/metrics';
import { toWebVitalReport } from '@/lib/observability/web-vitals';

/**
 * Reporta LCP, INP, CLS y TTFB al sink de métricas (Sentry) sin PII.
 *
 * Este módulo se carga de forma diferida desde `WebVitalsLoader` después del
 * `load`, así `next/web-vitals` y el observer no forman parte del bundle
 * inicial. `useReportWebVitals` entrega las entradas buffereadas, por lo que
 * LCP/CLS/TTFB de la carga inicial no se pierden por el diferimiento.
 */

type ReportWebVitalsCallback = Parameters<typeof useReportWebVitals>[0];

const release = process.env.NEXT_PUBLIC_BUILD_ID || 'unknown';

const reportWebVitals: ReportWebVitalsCallback = (metric) => {
  const report = toWebVitalReport(metric, {
    pathname: window.location.pathname,
    width: window.innerWidth,
    release,
  });

  if (report) recordWebVital(report);
};

export function WebVitalsReporter() {
  useReportWebVitals(reportWebVitals);

  return null;
}
