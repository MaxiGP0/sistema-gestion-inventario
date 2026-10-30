/**
 * Intervalo de respaldo con reconocimiento de visibilidad.
 *
 * Pensado para `NotificationsBell`: el SSE es la vía principal de refresco y
 * este poller solo cubre el caso en que el stream no está disponible. A
 * diferencia de un `setInterval` clásico, `sync()` recalcula el estado y cada
 * tick revalida las condiciones, así que nunca se consulta con la pestaña
 * oculta (criterio: sin requests cada 10 s en pestañas ocultas).
 */

export interface VisibilityPollOptions {
  /** Cadencia de los ticks en milisegundos (p. ej. 10 000). */
  intervalMs: number;
  /** Debe devolver true cuando el respaldo tenga sentido (p. ej. SSE caído). */
  isNeeded: () => boolean;
  /** Debe devolver true con la pestaña en segundo plano (`document.hidden`). */
  isHidden: () => boolean;
  /** Consulta que se ejecuta en cada tick con la pestaña visible. */
  onTick: () => void;
}

export interface VisibilityPoll {
  /** Arranca, mantiene o detiene el intervalo según `isHidden()`/`isNeeded()`. */
  sync: () => void;
  /** Detiene el intervalo (al desmontar o pausar explícitamente). */
  stop: () => void;
  /** true mientras el intervalo esté activo (diagnóstico y tests). */
  isRunning: () => boolean;
}

export function createVisibilityPoll({
  intervalMs,
  isNeeded,
  isHidden,
  onTick,
}: VisibilityPollOptions): VisibilityPoll {
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const sync = () => {
    if (isHidden() || !isNeeded()) {
      stop();
      return;
    }

    if (timer === null) {
      timer = setInterval(() => {
        // Revalidación defensiva: aunque el llamador no llame a sync() (por
        // ejemplo si el navegador retrasa el ciclo del timer en segundo
        // plano), un tick nunca consulta con la pestaña oculta o el SSE sano.
        if (!isHidden() && isNeeded()) onTick();
      }, intervalMs);
    }
  };

  return { sync, stop, isRunning: () => timer !== null };
}
