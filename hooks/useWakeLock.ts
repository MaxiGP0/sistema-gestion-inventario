'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Preferencia local: el operario no vuelve a activarlo en cada pedido. */
export const WAKE_LOCK_STORAGE_KEY = 'sgi_keep_awake';

export interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
  removeEventListener?: (type: 'release', listener: () => void) => void;
}

export interface WakeLockNavigatorLike {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  } | null;
}

export interface WakeLockState {
  supported: boolean;
  active: boolean;
  error: string | null;
}

export interface WakeLockControllerOptions {
  navigator?: WakeLockNavigatorLike | null;
  onChange?: (state: WakeLockState) => void;
}

export interface WakeLockController {
  setEnabled: (enabled: boolean) => void;
  markUserInteraction: () => void;
  handleVisibilityChange: (hidden: boolean) => void;
  dispose: () => void;
  getState: () => WakeLockState;
}

const NOT_ALLOWED_ERROR = 'El navegador no permitió mantener la pantalla encendida.';
const GENERIC_ERROR = 'No se pudo mantener la pantalla encendida.';

/** localStorage puede no estar disponible (SSR o modo privado). */
function resolveStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readWakeLockPreference(storage: Storage | null = resolveStorage()): boolean {
  try {
    return storage?.getItem(WAKE_LOCK_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeWakeLockPreference(
  enabled: boolean,
  storage: Storage | null = resolveStorage(),
): void {
  try {
    storage?.setItem(WAKE_LOCK_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // El navegador puede bloquear localStorage: la preferencia no persiste,
    // pero el modo sigue funcionando durante la sesión.
  }
}

export function isWakeLockSupported(navigatorLike?: WakeLockNavigatorLike | null): boolean {
  return Boolean(navigatorLike?.wakeLock && typeof navigatorLike.wakeLock.request === 'function');
}

/**
 * Controlador puro del Wake Lock. El hook sólo lo conecta con React y los
 * eventos del navegador; este estado se prueba con un `navigator.wakeLock`
 * simulado, sin depender de un DOM real.
 */
export function createWakeLockController(
  options: WakeLockControllerOptions = {},
): WakeLockController {
  const navigatorLike = options.navigator ?? null;
  const supported = isWakeLockSupported(navigatorLike);

  let enabled = false;
  let interacted = false;
  let hidden = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = false;
  let generation = 0;
  let error: string | null = null;
  let state: WakeLockState = { supported, active: false, error: null };

  const computeState = (): WakeLockState => ({
    supported,
    active: Boolean(sentinel && !sentinel.released),
    error,
  });

  const emit = () => {
    if (disposed) return;
    state = computeState();
    options.onChange?.(state);
  };

  const shouldHold = () => enabled && interacted && !hidden && supported && !disposed;

  const invalidatePending = () => {
    generation += 1;
    pending = false;
  };

  const releaseSentinel = (current: WakeLockSentinelLike | null) => {
    if (!current) return;

    try {
      const result = current.release();
      if (result && typeof result.catch === 'function') void result.catch(() => {});
    } catch {
      // Algunos navegadores lanzan si el lock ya se liberó solo.
    }
  };

  const releaseCurrent = () => {
    invalidatePending();
    const current = sentinel;
    sentinel = null;
    releaseSentinel(current);
    emit();
  };

  const requestLock = () => {
    if (!navigatorLike?.wakeLock || typeof navigatorLike.wakeLock.request !== 'function') return;

    const token = ++generation;
    pending = true;

    let request: Promise<WakeLockSentinelLike>;
    try {
      request = navigatorLike.wakeLock.request('screen');
    } catch (requestError: unknown) {
      pending = false;
      error =
        (requestError as { name?: string } | null)?.name === 'NotAllowedError'
          ? NOT_ALLOWED_ERROR
          : GENERIC_ERROR;
      emit();
      return;
    }

    Promise.resolve(request)
      .then((next) => {
        // Llegó tarde: la pestaña se ocultó, se desmontó o se desactivó.
        if (disposed || token !== generation || !shouldHold()) {
          releaseSentinel(next);
          return;
        }

        pending = false;
        sentinel = next;
        error = null;

        try {
          next.addEventListener?.('release', () => {
            // La liberación automática del sistema no debe pisar un lock nuevo.
            if (sentinel !== next) return;
            sentinel = null;
            emit();
          });
        } catch {
          // Sin listener igualmente se libera al ocultar/desmontar.
        }

        emit();
      })
      .catch((requestError: unknown) => {
        if (disposed || token !== generation) return;

        pending = false;
        error =
          (requestError as { name?: string } | null)?.name === 'NotAllowedError'
            ? NOT_ALLOWED_ERROR
            : GENERIC_ERROR;
        emit();
      });
  };

  const sync = () => {
    if (disposed) return;

    if (!shouldHold()) {
      if (sentinel || pending) releaseCurrent();
      return;
    }

    if (sentinel || pending) return;
    requestLock();
  };

  return {
    setEnabled(next) {
      enabled = next;
      sync();
    },
    markUserInteraction() {
      if (interacted) return;
      interacted = true;
      sync();
    },
    handleVisibilityChange(nextHidden) {
      hidden = nextHidden;
      if (hidden) releaseCurrent();
      else sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidatePending();
      const current = sentinel;
      sentinel = null;
      releaseSentinel(current);
    },
    getState() {
      return state;
    },
  };
}

/**
 * Mantiene la pantalla encendida mientras `enabled` sea true. La solicitud se
 * hace después de la primera interacción del usuario, porque algunos
 * navegadores rechazan el pedido durante la carga inicial.
 */
export function useWakeLock(enabled: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>({
    supported: false,
    active: false,
    error: null,
  });
  const controllerRef = useRef<WakeLockController | null>(null);
  const previousEnabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    const navigatorLike =
      typeof navigator === 'undefined' ? null : (navigator as unknown as WakeLockNavigatorLike);
    const controller = createWakeLockController({
      navigator: navigatorLike,
      onChange: setState,
    });

    controllerRef.current = controller;
    setState(controller.getState());

    const markInteraction = () => controller.markUserInteraction();
    const handleVisibility = () => controller.handleVisibilityChange(document.hidden);

    window.addEventListener('pointerdown', markInteraction, { passive: true });
    window.addEventListener('keydown', markInteraction);
    window.addEventListener('touchstart', markInteraction, { passive: true });
    document.addEventListener('visibilitychange', handleVisibility);

    if (document.hidden) controller.handleVisibilityChange(true);

    return () => {
      window.removeEventListener('pointerdown', markInteraction);
      window.removeEventListener('keydown', markInteraction);
      window.removeEventListener('touchstart', markInteraction);
      document.removeEventListener('visibilitychange', handleVisibility);
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setEnabled(enabled);

    // La primera pasada refleja el estado inicial del componente. No se
    // escribe la preferencia todavía para no pisar el valor guardado antes de
    // que el componente lo lea; los cambios posteriores sí persisten.
    const previous = previousEnabledRef.current;
    previousEnabledRef.current = enabled;
    if (previous !== null && previous !== enabled) writeWakeLockPreference(enabled);
  }, [enabled]);

  return state;
}

/** Estado controlado de la preferencia persistida en `sgi_keep_awake`. */
export function useWakeLockPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    setEnabledState(readWakeLockPreference());
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeWakeLockPreference(next);
  }, []);

  return [enabled, setEnabled];
}
