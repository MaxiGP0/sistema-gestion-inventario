/**
 * Utilidades de timeout para peticiones HTTP.
 *
 * `createRequestTimeout` combina la señal del llamador con un vencimiento
 * propio. Usa `AbortSignal.any` cuando el navegador lo soporta; si no, arma un
 * `AbortController` manual que escucha ambas señales. El llamador debe invocar
 * `cleanup()` en un `finally` para liberar el timer y los listeners.
 *
 * `raceWithAbort` garantiza que una promesa se rechace al vencer la señal
 * aunque el `fetch` subyacente ignore el abort (por ejemplo, una red colgada).
 */

/** Razón de aborto cuando el entorno no expone `signal.reason`. */
function fallbackAbortReason(): unknown {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('La operación fue cancelada', 'AbortError');
  }

  const error = new Error('La operación fue cancelada');
  error.name = 'AbortError';
  return error;
}

/** Motivo de una señal abortada, con fallback para navegadores viejos. */
export function signalAbortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? fallbackAbortReason() : signal.reason;
}

export interface RequestTimeout {
  /** Señal combinada; `undefined` cuando el timeout está desactivado. */
  signal: AbortSignal | undefined;
  /** ¿El vencimiento fue la causa del aborto? */
  timedOut: () => boolean;
  /** Libera el timer y los listeners. Idempotente. */
  cleanup: () => void;
}

type AbortListener = [signal: AbortSignal, listener: () => void];

/**
 * Crea una señal que vence a los `timeoutMs` y, si hay una señal externa, se
 * aborta también cuando el llamador cancela.
 *
 * `timeoutMs <= 0` desactiva el timer y devuelve la señal externa tal cual.
 */
export function createRequestTimeout(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): RequestTimeout {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal: externalSignal,
      timedOut: () => false,
      cleanup: () => {},
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const listeners: AbortListener[] = [];

  const listen = (signal: AbortSignal, listener: () => void) => {
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  };

  let timeoutSignal: AbortSignal;

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
  } else {
    const controller = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeoutSignal = controller.signal;
  }

  // Se registra antes de combinar para que `timedOut()` ya sea true cuando el
  // fetch rechace por el aborto.
  listen(timeoutSignal, () => {
    timedOut = true;
  });

  let signal: AbortSignal;

  if (!externalSignal) {
    signal = timeoutSignal;
  } else if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any([externalSignal, timeoutSignal]);
  } else {
    // Fallback para navegadores sin AbortSignal.any: un controlador propio
    // escucha la señal externa y la del timeout.
    const combined = new AbortController();

    const abortCombined = () => {
      if (combined.signal.aborted) return;
      combined.abort(
        externalSignal.aborted
          ? signalAbortReason(externalSignal)
          : signalAbortReason(timeoutSignal),
      );
    };

    if (externalSignal.aborted || timeoutSignal.aborted) {
      abortCombined();
    } else {
      listen(externalSignal, abortCombined);
      listen(timeoutSignal, abortCombined);
    }

    signal = combined.signal;
  }

  return {
    signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const [abortSignal, listener] of listeners) {
        abortSignal.removeEventListener('abort', listener);
      }
      listeners.length = 0;
    },
  };
}

/**
 * Espera `promise`, pero la rechaza en cuanto `signal` se aborta. Si la
 * promesa original falla después, su rechazo queda manejado por el `.then`
 * adjunto y no genera un unhandled rejection.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;

  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signalAbortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signalAbortReason(signal));

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
