/**
 * Ejecuta trabajo best-effort después de enviar la respuesta.
 *
 * En un route handler real usa `after()` de `next/server`, que corre la tarea
 * cuando la respuesta (o el prerender) ya terminó. Los tests y scripts que
 * invocan el handler directamente no tienen el request scope de Next, así que
 * se conserva el mismo comportamiento no bloqueante agendando la tarea en la
 * cola de microtareas. El llamador nunca espera la tarea.
 */

import { after } from 'next/server';

export function runAfterResponse(task: () => void | Promise<void>): void {
  try {
    after(task);
  } catch {
    // Sin request scope (por ejemplo, handler invocado desde un test).
    void Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error('Error en una tarea posterior a la respuesta:', error);
      });
  }
}
