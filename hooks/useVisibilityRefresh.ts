'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Umbral por defecto para considerar que la pestaña estuvo oculta "un rato". */
export const DEFAULT_VISIBILITY_REFRESH_MS = 30_000;

export interface VisibilityRefreshOptions {
  /** Tiempo mínimo oculto antes de revalidar. */
  minHiddenMs?: number;
  /** Ventana mínima entre dos revalidaciones, incluso si hubo varios eventos. */
  minIntervalMs?: number;
}

export interface VisibilityRefreshState {
  hiddenAt: number | null;
  lastRefreshAt: number;
}

/**
 * Decide si un regreso a primer plano amerita revalidar.
 *
 * - Sin `hiddenAt` no hubo una ocultación registrada: no se refresca.
 * - Una ausencia corta (cambio de app de pocos segundos) no dispara requests.
 * - `lastRefreshAt` evita ráfagas cuando el navegador emite varios eventos
 *   seguidos (visibilitychange + focus/pageshow).
 */
export function shouldRefreshAfterVisibility(
  state: VisibilityRefreshState,
  now: number,
  options: VisibilityRefreshOptions = {},
): boolean {
  const minHiddenMs = options.minHiddenMs ?? DEFAULT_VISIBILITY_REFRESH_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_VISIBILITY_REFRESH_MS;

  if (state.hiddenAt === null) return false;
  if (now - state.hiddenAt < minHiddenMs) return false;
  if (state.lastRefreshAt > 0 && now - state.lastRefreshAt < minIntervalMs) return false;

  return true;
}

export interface VisibilityRefreshTracker {
  markHidden: (now?: number) => void;
  /** Evalúa el regreso y limpia `hiddenAt` (aunque no corresponda refrescar). */
  shouldRefreshOnVisible: (now?: number) => boolean;
  markRefreshed: (now?: number) => void;
  getState: () => Readonly<VisibilityRefreshState>;
}

/**
 * Estado puro del hook. Se exporta para poder probar la secuencia de eventos
 * con un reloj falso sin montar React ni depender de un DOM real.
 */
export function createVisibilityRefreshTracker(
  options: VisibilityRefreshOptions = {},
): VisibilityRefreshTracker {
  let hiddenAt: number | null = null;
  let lastRefreshAt = 0;

  return {
    markHidden(now = Date.now()) {
      if (hiddenAt === null) hiddenAt = now;
    },
    shouldRefreshOnVisible(now = Date.now()) {
      const shouldRefresh = shouldRefreshAfterVisibility({ hiddenAt, lastRefreshAt }, now, options);
      hiddenAt = null;
      return shouldRefresh;
    },
    markRefreshed(now = Date.now()) {
      lastRefreshAt = now;
    },
    getState() {
      return { hiddenAt, lastRefreshAt };
    },
  };
}

/**
 * Revalida al volver a la pestaña sólo después de una ausencia relevante.
 *
 * Los listeners de `visibilitychange`, `focus` y `pageshow` comparten el mismo
 * tracker: si el navegador restaura la página desde bfcache y emite varios
 * eventos, el segundo no vuelve a consultar.
 */
export function useVisibilityRefresh(
  callback: () => void | Promise<void>,
  options: VisibilityRefreshOptions = {},
): { refreshNow: () => void } {
  const callbackRef = useRef(callback);
  const trackerRef = useRef<VisibilityRefreshTracker>(createVisibilityRefreshTracker(options));
  const minHiddenMs = options.minHiddenMs ?? DEFAULT_VISIBILITY_REFRESH_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_VISIBILITY_REFRESH_MS;

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    trackerRef.current = createVisibilityRefreshTracker({ minHiddenMs, minIntervalMs });
  }, [minHiddenMs, minIntervalMs]);

  const invoke = useCallback(() => {
    try {
      const result = callbackRef.current();
      if (result && typeof result.then === 'function') {
        void result.catch((error: unknown) => {
          console.error('Error al revalidar al volver a primer plano:', error);
        });
      }
    } catch (error) {
      console.error('Error al revalidar al volver a primer plano:', error);
    }
  }, []);

  const refreshNow = useCallback(() => {
    const now = Date.now();
    trackerRef.current.markRefreshed(now);
    invoke();
  }, [invoke]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const markHidden = () => {
      trackerRef.current.markHidden(Date.now());
    };

    const handleVisible = () => {
      const now = Date.now();
      if (!trackerRef.current.shouldRefreshOnVisible(now)) return;
      trackerRef.current.markRefreshed(now);
      invoke();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) markHidden();
      else handleVisible();
    };

    // `pagehide` cubre la entrada a bfcache; `pageshow` el regreso. En una
    // restauración desde bfcache no siempre llega `visibilitychange`.
    const handlePageHide = () => markHidden();
    const handlePageShow = () => handleVisible();
    const handleFocus = () => {
      if (!document.hidden) handleVisible();
    };

    if (document.hidden) markHidden();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handleFocus);
    };
  }, [invoke]);

  return { refreshNow };
}
