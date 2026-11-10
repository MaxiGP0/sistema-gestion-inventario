/**
 * Controlador de autoguardado del borrador de pedido.
 *
 * Se separa del hook para poder probar el debounce, el flush inmediato de
 * `pagehide`/`visibilitychange` y la protección contra escribir el estado
 * inicial antes de que termine la restauración.
 */
import {
  clearOrderDraft,
  saveOrderDraft,
  type OrderDraft,
  type OrderDraftStorage,
} from './order-draft';

/** Debounce original del alta. */
export const ORDER_DRAFT_DEBOUNCE_MS = 400;

/** Sólo persiste los campos del borrador (nunca estado efímero del formulario). */
export function toStoredOrderDraft(draft: OrderDraft): OrderDraft {
  return {
    quantities: draft.quantities,
    selectedClient: draft.selectedClient,
    salesperson: draft.salesperson,
    comment: draft.comment,
    itemDiscounts: draft.itemDiscounts,
    generalDiscount: draft.generalDiscount,
    brandDiscounts: draft.brandDiscounts,
    invoiceType: draft.invoiceType,
    paymentCondition: draft.paymentCondition,
    paymentConditionDetail: draft.paymentConditionDetail,
  };
}

/** Serialización estable para comparar el draft actual con el último guardado. */
export function serializeOrderDraft(draft: OrderDraft): string {
  return JSON.stringify(toStoredOrderDraft(draft));
}

export interface OrderDraftAutosaveOptions {
  storage: OrderDraftStorage | null | undefined;
  userId: string | null | undefined;
  /** Pedido en edición (`mode="edit"`); usa clave aislada por pedido. */
  orderId?: string | null;
  /** Versión del pedido en edición para guardar junto al borrador. */
  version?: number;
  debounceMs?: number;
  /** Con `false` no se lee ni se escribe el borrador. */
  enabled?: boolean;
}

export interface OrderDraftAutosaveController {
  /** Marca el estado actual como base sin escribir (alta vacía o precarga). */
  setBaseline(draft: OrderDraft): void;
  /**
   * Marca un borrador restaurado como base. No escribe hasta que el formulario
   * refleje ese borrador, para no pisarlo con el estado inicial vacío.
   */
  setRestoredBaseline(draft: OrderDraft): void;
  /** Programa un guardado con debounce si hay cambios respecto de la base. */
  schedule(draft: OrderDraft): void;
  /** Escribe ya, cancelando el timer pendiente. Devuelve si hubo escritura. */
  flush(): boolean;
  /** Cancela el timer pendiente sin escribir. */
  cancel(): void;
  /** Borra el borrador persistido y cancela el timer. */
  clear(): void;
  /** ¿Hay cambios pendientes de persistir? */
  isDirty(): boolean;
}

export function createOrderDraftAutosave({
  storage,
  userId,
  orderId,
  version,
  debounceMs = ORDER_DRAFT_DEBOUNCE_MS,
  enabled = true,
}: OrderDraftAutosaveOptions): OrderDraftAutosaveController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: OrderDraft | null = null;
  let lastSavedJson: string | null = null;
  let baselineReady = false;
  let waitingForRestore = false;

  const hasValidScope = () => {
    if (orderId === undefined || orderId === null) return true;
    return typeof orderId === 'string' && Boolean(orderId.trim());
  };

  const canPersist = () =>
    Boolean(enabled && storage && userId && userId.trim() && hasValidScope());

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const write = (draft: OrderDraft): boolean => {
    if (!canPersist()) return false;

    const stored = toStoredOrderDraft(draft);
    const saved = saveOrderDraft(storage, stored, userId, { orderId, version });
    if (saved) {
      lastSavedJson = JSON.stringify(stored);
      baselineReady = true;
      waitingForRestore = false;
    }
    return saved;
  };

  return {
    setBaseline(draft) {
      cancelTimer();
      current = draft;
      lastSavedJson = serializeOrderDraft(draft);
      baselineReady = true;
      waitingForRestore = false;
    },

    setRestoredBaseline(draft) {
      cancelTimer();
      current = draft;
      lastSavedJson = serializeOrderDraft(draft);
      baselineReady = true;
      waitingForRestore = true;
    },

    schedule(draft) {
      current = draft;

      if (!canPersist()) {
        cancelTimer();
        return;
      }

      const json = serializeOrderDraft(draft);

      // Primera ejecución sin base: se toma el estado inicial como referencia
      // y no se escribe un borrador vacío sólo por montar la pantalla.
      if (!baselineReady) {
        lastSavedJson = json;
        baselineReady = true;
        return;
      }

      // La restauración puede transformar el borrador guardado (por ejemplo,
      // al aplicar `?clientId=`). El primer estado posterior a la restauración
      // es la nueva base: se adopta sin escribirlo para no pisarlo con el
      // estado vacío inicial ni forzar una escritura redundante.
      if (waitingForRestore) {
        lastSavedJson = json;
        waitingForRestore = false;
        cancelTimer();
        return;
      }

      if (json === lastSavedJson) {
        cancelTimer();
        return;
      }

      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        write(draft);
      }, debounceMs);
    },

    flush() {
      cancelTimer();

      if (!canPersist() || !current || !baselineReady || waitingForRestore) return false;
      if (serializeOrderDraft(current) === lastSavedJson) return false;

      return write(current);
    },

    cancel() {
      cancelTimer();
    },

    clear() {
      cancelTimer();
      if (canPersist()) clearOrderDraft(storage, userId, { orderId });
      lastSavedJson = null;
      baselineReady = false;
      waitingForRestore = false;
    },

    isDirty() {
      if (!canPersist() || !current || !baselineReady || waitingForRestore) return false;
      return serializeOrderDraft(current) !== lastSavedJson;
    },
  };
}

export interface OrderDraftLifecycleTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface OrderDraftLifecycleOptions {
  windowTarget?: OrderDraftLifecycleTarget | null;
  documentTarget?: OrderDraftLifecycleTarget | null;
  isDocumentHidden?: () => boolean;
}

/**
 * Guarda el borrador de inmediato al ocultar/cerrar la página. localStorage es
 * sincrónico, así que alcanza a escribirse antes de que el navegador congele
 * la pestaña.
 */
export function attachOrderDraftLifecycleFlush(
  flush: () => void,
  options: OrderDraftLifecycleOptions = {},
): () => void {
  const windowTarget =
    options.windowTarget ??
    (typeof window !== 'undefined' ? (window as unknown as OrderDraftLifecycleTarget) : null);
  const documentTarget =
    options.documentTarget ??
    (typeof document !== 'undefined' ? (document as unknown as OrderDraftLifecycleTarget) : null);
  const isHidden =
    options.isDocumentHidden ?? (() => (typeof document !== 'undefined' ? document.hidden : false));

  const onPageHide = () => flush();
  const onVisibilityChange = () => {
    if (isHidden()) flush();
  };

  windowTarget?.addEventListener('pagehide', onPageHide);
  documentTarget?.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    windowTarget?.removeEventListener('pagehide', onPageHide);
    documentTarget?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
