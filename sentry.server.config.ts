/**
 * Sentry en el runtime Node. Se importa desde `instrumentation.ts` después de
 * validar las variables obligatorias de la app.
 */

import * as Sentry from '@sentry/nextjs';
import { serverSentryOptions } from './lib/observability/sentry-config';

const options = serverSentryOptions();
if (options) {
  Sentry.init(options);
}
