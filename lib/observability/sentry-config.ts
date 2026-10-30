/**
 * Configuración compartida de Sentry para Node, Edge y browser.
 *
 * Decisiones clave:
 * - `sampleRate: 1`: los errores reales nunca se muestrean. `tracesSampleRate`
 *   solo afecta traces/performance y no debe confundirse con errores.
 * - `sendDefaultPii: false` + `dataCollection` restrictivo: sin cuerpos, sin
 *   cookies, sin query strings y sin datos de usuario.
 * - `beforeSend`/`beforeBreadcrumb`: segunda barrera de redacción.
 * - `/api/health` no se traza para no llenar el cupo de performance con probes,
 *   pero un 503 sí se captura como evento/métrica.
 *
 * Sin DSN Sentry no se inicializa y todas las llamadas quedan en no-op: la app
 * funciona igual en desarrollo y en los tests.
 */

import type { Breadcrumb, ErrorEvent, Metric } from '@sentry/nextjs';
import type { StreamedSpanJSON } from '@sentry/core';
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
  type ScrubbableSpan,
} from './redact';

/** Los errores se envían siempre; no se permite bajarlo por configuración. */
export const ERROR_SAMPLE_RATE = 1;

const DEFAULT_PRODUCTION_TRACE_RATE = 0.1;
const DEFAULT_DEVELOPMENT_TRACE_RATE = 1;

export type SentryRuntime = 'client' | 'server' | 'edge';

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseRate(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampRate(parsed) : undefined;
}

/** DSN del servidor o del cliente (el DSN es público, no es un secreto). */
export function getSentryDsn(runtime: SentryRuntime): string | undefined {
  const raw =
    runtime === 'client'
      ? process.env.NEXT_PUBLIC_SENTRY_DSN
      : process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

  const dsn = raw?.trim();
  return dsn ? dsn : undefined;
}

export function isSentryEnabled(runtime: SentryRuntime): boolean {
  return Boolean(getSentryDsn(runtime));
}

export function getSentryEnvironment(): string {
  return (
    process.env.SENTRY_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.NODE_ENV ||
    'development'
  );
}

export function getSentryRelease(): string | undefined {
  const release =
    process.env.SENTRY_RELEASE?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.trim();

  return release || undefined;
}

/**
 * Muestreo de traces. Se puede bajar a 0 para apagar performance sin afectar
 * la captura de errores, que usa `sampleRate: 1`.
 */
export function getTracesSampleRate(): number {
  const explicit = parseRate(process.env.SENTRY_TRACES_SAMPLE_RATE);
  if (explicit !== undefined) return explicit;

  const publicRate = parseRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE);
  if (publicRate !== undefined) return publicRate;

  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PRODUCTION_TRACE_RATE
    : DEFAULT_DEVELOPMENT_TRACE_RATE;
}

/** Opciones comunes, sin DSN, para los tres runtimes. */
export function commonSentryOptions(runtime: SentryRuntime) {
  const tracesSampleRate = getTracesSampleRate();

  return {
    environment: getSentryEnvironment(),
    release: getSentryRelease(),

    // Errores: 100 %. Traces: configurables y sin relación con la captura de errores.
    sampleRate: ERROR_SAMPLE_RATE,
    tracesSampler: ({ name }: { name?: string }) => {
      if (name?.includes('/api/health')) return 0;
      return tracesSampleRate;
    },

    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    attachStacktrace: true,

    // Sin cuerpos, cookies, query strings ni datos de usuario.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: {
          allow: ['x-request-id', 'user-agent', 'content-type', 'accept', 'accept-language'],
        },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },

    initialScope: {
      tags: {
        app: 'sistema-gestion-inventario',
        runtime,
      },
    },

    beforeSend(event: ErrorEvent) {
      return scrubEvent(event as unknown as ScrubbableEvent) as unknown as ErrorEvent;
    },
    beforeBreadcrumb(breadcrumb: Breadcrumb) {
      return scrubBreadcrumb(breadcrumb as ScrubbableBreadcrumb) as Breadcrumb;
    },
    beforeSendSpan(span: StreamedSpanJSON) {
      return scrubSpan(span as unknown as ScrubbableSpan) as unknown as StreamedSpanJSON;
    },
    beforeSendMetric(metric: Metric) {
      metric.attributes = {
        ...(metric.attributes ?? {}),
        app: 'sistema-gestion-inventario',
        runtime,
      };
      return metric;
    },
  };
}

/** Opciones del servidor Node; `null` si no hay DSN. */
export function serverSentryOptions() {
  const dsn = getSentryDsn('server');
  if (!dsn) return null;
  return { dsn, ...commonSentryOptions('server') };
}

/** Opciones del runtime Edge; `null` si no hay DSN. */
export function edgeSentryOptions() {
  const dsn = getSentryDsn('edge');
  if (!dsn) return null;
  return { dsn, ...commonSentryOptions('edge') };
}

/** Opciones del browser; `null` si no hay DSN público. */
export function clientSentryOptions() {
  const dsn = getSentryDsn('client');
  if (!dsn) return null;
  return { dsn, ...commonSentryOptions('client') };
}
