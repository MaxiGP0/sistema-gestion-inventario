'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import Button from '@/components/ui/Button';

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';
const SERVICE_WORKER_URL = `/sw.js?v=${encodeURIComponent(BUILD_ID)}`;

/**
 * Registra el service worker y gestiona la actualización.
 *
 * El SW no hace `skipWaiting()` al instalar: si ya hay una versión activa, la
 * nueva queda en `waiting`. Este componente muestra el aviso y sólo manda
 * `SKIP_WAITING` cuando el usuario acepta. Al activarse, `controllerchange`
 * recarga una vez todas las pestañas controladas para no mezclar versiones.
 */
export default function ServiceWorkerManager() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [applying, setApplying] = useState(false);

  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const hadControllerRef = useRef(false);
  const reloadRequestedRef = useRef(false);
  const reloadingRef = useRef(false);
  const mountedRef = useRef(true);
  const lastUpdateCheckRef = useRef(0);

  const applyUpdate = useCallback(() => {
    const worker = waitingWorker ?? registrationRef.current?.waiting;
    if (!worker) return;

    setApplying(true);
    reloadRequestedRef.current = true;
    worker.postMessage({ type: 'SKIP_WAITING' });

    // Red de seguridad: si el navegador no dispara `controllerchange` (por
    // ejemplo, porque el worker ya estaba activo), recargamos igual una vez.
    window.setTimeout(() => {
      if (!mountedRef.current || reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    }, 8_000);
  }, [waitingWorker]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    mountedRef.current = true;
    hadControllerRef.current = Boolean(navigator.serviceWorker.controller);

    let cleanupWorkerListener: (() => void) | undefined;
    let cleanupUpdateFound: (() => void) | undefined;

    const showWaitingWorker = (worker: ServiceWorker | null) => {
      if (!worker) return;

      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        if (mountedRef.current) setWaitingWorker(worker);
      }
    };

    const watchWorker = (worker: ServiceWorker | null) => {
      cleanupWorkerListener?.();
      cleanupWorkerListener = undefined;
      if (!worker) return;

      const handleStateChange = () => {
        showWaitingWorker(worker);
      };

      worker.addEventListener('statechange', handleStateChange);
      showWaitingWorker(worker);

      cleanupWorkerListener = () => worker.removeEventListener('statechange', handleStateChange);
    };

    const handleControllerChange = () => {
      // En la primera instalación el SW toma el control y también dispara
      // `controllerchange`; ahí no hay que recargar. En una actualización sí:
      // todas las pestañas controladas pasan a la versión nueva juntas.
      const shouldReload = reloadRequestedRef.current || hadControllerRef.current;

      if (!shouldReload || reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
          scope: '/',
          // No confiar en la caché HTTP para detectar una versión nueva.
          updateViaCache: 'none',
        });

        // Playwright con `serviceWorkers: 'block'` resuelve `register()` con
        // `undefined`; no hay nada que observar en ese caso.
        if (!registration || !mountedRef.current) return;
        registrationRef.current = registration;

        // Si ya había una versión esperando (por ejemplo, la pestaña se abrió
        // después de un despliegue), mostrarla sin esperar a otro `update()`.
        if (registration.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(registration.waiting);
        }

        // Un `updatefound` puede ocurrir antes de que `register()` resuelva;
        // revisar también el worker que ya está instalándose.
        watchWorker(registration.installing);

        const handleUpdateFound = () => {
          watchWorker(registration.installing);
        };

        registration.addEventListener('updatefound', handleUpdateFound);
        cleanupUpdateFound = () =>
          registration.removeEventListener('updatefound', handleUpdateFound);

        if (registration.waiting) showWaitingWorker(registration.waiting);

        void registration.update().catch(() => {
          // Sin red no se puede comprobar la versión; se reintenta al enfocar.
        });
      } catch (error) {
        console.warn('No se pudo registrar el service worker:', error);
      }
    };

    const checkForUpdate = () => {
      if (document.visibilityState === 'hidden') return;

      const now = Date.now();
      if (now - lastUpdateCheckRef.current < 60_000) return;
      lastUpdateCheckRef.current = now;

      void registrationRef.current?.update().catch(() => {
        // Sin red: no hay nada que actualizar.
      });
    };

    void register();
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    window.addEventListener('focus', checkForUpdate);
    document.addEventListener('visibilitychange', checkForUpdate);

    return () => {
      mountedRef.current = false;
      cleanupWorkerListener?.();
      cleanupUpdateFound?.();
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      window.removeEventListener('focus', checkForUpdate);
      document.removeEventListener('visibilitychange', checkForUpdate);
    };
  }, []);

  if (!waitingWorker) return null;

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+var(--mobile-sync-clearance))] z-50 mx-auto max-w-md rounded-lg border border-border bg-surface p-3 shadow-elevation-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:mx-0 sm:w-96"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-action-soft text-action-text">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Nueva versión disponible</p>
          <p className="mt-0.5 text-xs text-muted">
            Actualizá para evitar mezclar versiones entre pestañas.
          </p>

          <Button
            type="button"
            variant="primary"
            onClick={applyUpdate}
            disabled={applying}
            className="mt-3 max-sm:w-full"
          >
            {applying ? 'Actualizando…' : 'Actualizar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
