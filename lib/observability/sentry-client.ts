/**
 * Carga diferida del SDK de Sentry en el navegador.
 *
 * Sin `NEXT_PUBLIC_SENTRY_DSN` el SDK no se importa ni se descarga: el peso de
 * Sentry (~120 KB gzip) deja de estar en el bundle inicial de todas las rutas.
 * Con DSN, `instrumentation-client.ts` dispara la carga antes de la hidratación
 * y las capturas que ocurran mientras tanto quedan en cola, así no se pierde
 * ningún error.
 */

import type * as SentryNamespace from '@sentry/nextjs';
import { clientSentryOptions } from './sentry-config';

export type SentryClient = typeof SentryNamespace;

/** Se inlinea en build: sin DSN la rama dinámica se descarta. */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

let sentry: SentryClient | null = null;
let loading: Promise<SentryClient | null> | null = null;
const pending: Array<(module: SentryClient) => void> = [];

/** ¿La app tiene configurado Sentry para el navegador? */
export function isClientSentryEnabled(): boolean {
  return Boolean(dsn?.trim());
}

function drain(module: SentryClient): void {
  sentry = module;
  for (const task of pending.splice(0)) task(module);
}

/** Importa e inicializa Sentry una sola vez. Sin DSN resuelve `null`. */
export function loadClientSentry(): Promise<SentryClient | null> {
  if (!isClientSentryEnabled()) return Promise.resolve(null);
  if (sentry) return Promise.resolve(sentry);

  if (!loading) {
    loading = import('@sentry/nextjs')
      .then((module) => {
        const options = clientSentryOptions();

        if (options) {
          module.init(options);
          drain(module);
        }

        return module;
      })
      .catch((error: unknown) => {
        // Si el SDK no se puede cargar, las capturas pendientes se descartan
        // (no hay a dónde enviarlas) y la app sigue funcionando.
        pending.length = 0;
        console.error('No se pudo inicializar Sentry:', error);
        return null;
      });
  }

  return loading;
}

/**
 * Ejecuta `task` con el SDK inicializado. Si todavía está cargando, la tarea
 * se ejecuta al terminar (los errores tempranos no se pierden).
 */
export function withClientSentry(task: (module: SentryClient) => void): void {
  if (!isClientSentryEnabled()) return;

  if (sentry) {
    task(sentry);
    return;
  }

  pending.push(task);
  void loadClientSentry();
}
