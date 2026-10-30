/**
 * Cola de escrituras del control post-factura.
 *
 * Cada toque en `PostControlSelector` se aplica de forma optimista en la línea
 * y se encola. La cola:
 * - envía un lote por vez por pedido (nunca dos PATCH concurrentes),
 * - usa la última versión recibida al momento de enviar,
 * - une toques rápidos sobre la misma línea conservando el valor previo para
 *   poder hacer rollback,
 * - sólo reporta como fallidas las líneas que no tienen un cambio más nuevo
 *   pendiente (ese cambio se enviará en el próximo lote).
 *
 * Es un módulo puro, con la red inyectada, para poder probarlo con `node:test`.
 */
import type { PostControl } from './order-post-control';

export interface PostControlSyncUpdate {
  itemId: string;
  postControl: PostControl;
  /** Valor local anterior al primer cambio pendiente de esta línea. */
  previous: PostControl;
}

export interface PostControlWireUpdate {
  _id: string;
  postControl: PostControl;
}

export interface PostControlWriteQueueOptions {
  /** Última versión conocida del pedido. Se lee al iniciar cada lote. */
  getVersion: () => number;
  /** Envía el lote y actualiza la versión conocida por fuera de la cola. */
  send: (updates: PostControlWireUpdate[], version: number) => Promise<void>;
  /** Marca/desmarca el indicador sutil de guardado por línea. */
  onSavingChange?: (itemIds: readonly string[], saving: boolean) => void;
  /** Entrega las líneas a revertir cuando el PATCH falla. */
  onError?: (failed: readonly PostControlSyncUpdate[], error: unknown) => void;
}

export class PostControlWriteQueue {
  private readonly pending = new Map<string, PostControlSyncUpdate>();
  /** Valor previo al primer toque todavía no confirmado de cada línea. */
  private readonly origin = new Map<string, PostControl>();
  private running = false;
  private scheduled = false;
  private disposed = false;

  constructor(private readonly options: PostControlWriteQueueOptions) {}

  /** Cantidad de líneas con cambios esperando ser enviados. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Encola el último valor elegido para una línea. Si ya había un cambio
   * pendiente, se conserva el `previous` original para que el rollback vuelva
   * al valor que vio el usuario antes de empezar a tocar la línea.
   */
  enqueue(change: PostControlSyncUpdate): void {
    if (this.disposed) return;

    // El primer valor de la ráfaga es el que hay que restaurar si el servidor
    // rechaza el cambio, aunque el usuario ya haya tocado la línea otra vez.
    const previous = this.origin.get(change.itemId) ?? change.previous;
    if (!this.origin.has(change.itemId)) this.origin.set(change.itemId, previous);

    this.pending.set(change.itemId, {
      itemId: change.itemId,
      postControl: change.postControl,
      previous,
    });

    this.options.onSavingChange?.([change.itemId], true);
    this.scheduleDrain();
  }

  /** Cancela envíos pendientes al desmontar la pantalla. */
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.origin.clear();
  }

  /** Espera a que no queden escrituras en curso (usado por los tests). */
  async whenIdle(): Promise<void> {
    while (this.running || this.scheduled || this.pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * Agrupa los toques del mismo tick antes de iniciar el PATCH. Así dos
   * enqueues inmediatos salen en un solo lote, no en dos viajes encadenados.
   */
  private scheduleDrain(): void {
    if (this.running || this.scheduled || this.disposed) return;

    this.scheduled = true;
    void Promise.resolve().then(() => {
      this.scheduled = false;
      if (!this.disposed && !this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (!this.disposed && this.pending.size > 0) {
        // Se toma el estado actual y se libera la cola antes del await: los
        // toques que lleguen mientras viaja el PATCH forman el lote siguiente.
        const batch = [...this.pending.values()];
        batch.forEach((change) => this.pending.delete(change.itemId));

        try {
          await this.options.send(
            batch.map(({ itemId, postControl }) => ({ _id: itemId, postControl })),
            this.options.getVersion(),
          );
        } catch (error: unknown) {
          // Una línea con un toque más nuevo ya tiene otro envío pendiente: no
          // se revierte para no pisar la última intención del usuario.
          if (this.disposed) continue;

          const failed = batch
            .filter((change) => !this.pending.has(change.itemId))
            .map((change) => ({
              ...change,
              previous: this.origin.get(change.itemId) ?? change.previous,
            }));

          if (failed.length > 0) this.options.onError?.(failed, error);
        } finally {
          const finished = batch
            .map((change) => change.itemId)
            .filter((itemId) => !this.pending.has(itemId));

          // Se confirma el valor original sólo cuando la línea ya no tiene
          // cambios posteriores en cola.
          finished.forEach((itemId) => this.origin.delete(itemId));

          if (!this.disposed && finished.length > 0) {
            this.options.onSavingChange?.(finished, false);
          }
        }
      }
    } finally {
      this.running = false;
      // Un enqueue pudo llegar justo después de evaluar el while y antes de
      // liberar `running`: se reanuda para no dejar el lote huérfano.
      if (!this.disposed && this.pending.size > 0) this.scheduleDrain();
    }
  }
}
