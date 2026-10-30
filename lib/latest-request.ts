/**
 * Coordinador de consultas con semántica "gana la última".
 *
 * Cada `start()`:
 * 1. aborta la consulta anterior (si sigue en curso);
 * 2. crea un `AbortController` nuevo y devuelve su `signal`;
 * 3. entrega un `requestId` monótono.
 *
 * `isCurrent(ticket)` combina las dos barreras: el id descarta respuestas que
 * llegaron tarde aunque no se hayan podido abortar (p. ej. el cuerpo ya estaba
 * en vuelo) y la señal descarta cualquier respuesta de una consulta cancelada.
 */

import { cancelRequest, createAbortController } from './api-client';

export interface LatestRequestTicket {
  /** Identificador incremental de la consulta. */
  readonly requestId: number;
  /** Señal que se pasa a `api.get`/`getCatalog`. */
  readonly signal: AbortSignal;
}

export interface LatestRequest {
  /** Inicia una consulta nueva y cancela la anterior. */
  start(): LatestRequestTicket;
  /** ¿La consulta sigue siendo la última y no fue cancelada? */
  isCurrent(ticket: LatestRequestTicket): boolean;
  /** Cancela la consulta en curso (desmontaje, cierre de modal, etc.). */
  abort(): void;
}

export function createLatestRequest(): LatestRequest {
  let sequence = 0;
  let current: { requestId: number; controller: AbortController } | null = null;

  return {
    start() {
      cancelRequest(current?.controller);
      const requestId = ++sequence;
      const controller = createAbortController();
      current = { requestId, controller };
      return { requestId, signal: controller.signal };
    },

    isCurrent(ticket) {
      return current?.requestId === ticket.requestId && !ticket.signal.aborted;
    },

    abort() {
      cancelRequest(current?.controller);
      current = null;
    },
  };
}
