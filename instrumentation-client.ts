/**
 * Instrumentación del cliente (Next.js la ejecuta antes de la hidratación).
 *
 * Sin `NEXT_PUBLIC_SENTRY_DSN` no se importa el SDK: no pesa en el bundle ni se
 * descarga. Con DSN se carga en paralelo antes de la hidratación; las capturas
 * que ocurran mientras tanto quedan en cola (ver `lib/observability/sentry-client`).
 *
 * `onRouterTransitionStart` agrega breadcrumbs de navegación para poder
 * reconstruir el camino hasta un error de render.
 */

import { clientSentryMetricsSink } from './lib/observability/metrics-client-sentry';
import { setMetricsSink } from './lib/observability/metrics';
import {
  isClientSentryEnabled,
  loadClientSentry,
  withClientSentry,
} from './lib/observability/sentry-client';

if (isClientSentryEnabled()) {
  setMetricsSink(clientSentryMetricsSink);
  void loadClientSentry();
}

export function onRouterTransitionStart(
  href: string,
  navigationType: 'push' | 'replace' | 'traverse',
): void {
  withClientSentry((Sentry) => Sentry.captureRouterTransitionStart(href, navigationType));
}
