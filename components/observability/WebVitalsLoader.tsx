'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

/**
 * Monta el reporter de Web Vitals después de la carga inicial.
 *
 * El objetivo es no agregar peso al bundle inicial: este componente sólo
 * aporta el `useState`/`useEffect` y el import dinámico; `next/web-vitals`
 * viaja en un chunk aparte que se descarga cuando la página terminó de cargar
 * y el navegador está idle. Sin `NEXT_PUBLIC_SENTRY_DSN` no se descarga nada,
 * porque no hay sink al que reportar.
 */
const WebVitalsReporter = dynamic(
  () => import('./WebVitalsReporter').then((module) => module.WebVitalsReporter),
  { ssr: false },
);

const reportingEnabled = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN?.trim());

export default function WebVitalsLoader() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!reportingEnabled) return;

    let cancelled = false;
    let timer: number | undefined;

    const enable = () => {
      if (!cancelled) setEnabled(true);
    };

    const schedule = () => {
      // `requestIdleCallback` no existe en Safari; el timeout es el fallback.
      if (typeof window.requestIdleCallback === 'function') {
        const idleId = window.requestIdleCallback(enable, { timeout: 3000 });
        return () => window.cancelIdleCallback(idleId);
      }

      timer = window.setTimeout(enable, 1500);
      return () => {
        if (timer !== undefined) window.clearTimeout(timer);
      };
    };

    let cancelSchedule: () => void = () => {};

    if (document.readyState === 'complete') {
      cancelSchedule = schedule();
    } else {
      const onLoad = () => {
        cancelSchedule = schedule();
      };

      window.addEventListener('load', onLoad, { once: true });
      cancelSchedule = () => window.removeEventListener('load', onLoad);
    }

    return () => {
      cancelled = true;
      cancelSchedule();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return enabled ? <WebVitalsReporter /> : null;
}
