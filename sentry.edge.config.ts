/**
 * Sentry en el runtime Edge. Las opciones comparten la misma redacción y
 * sampling que Node/browser, pero no usan APIs de Node.
 */

import * as Sentry from '@sentry/nextjs';
import { edgeSentryOptions } from './lib/observability/sentry-config';

const options = edgeSentryOptions();
if (options) {
  Sentry.init(options);
}
