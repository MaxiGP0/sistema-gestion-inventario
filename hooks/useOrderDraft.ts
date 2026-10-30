'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  clearOrderDraft,
  loadOrderDraft,
  saveOrderDraft,
  type OrderDraft,
  type OrderDraftStorage,
} from '@/lib/order-draft';

interface UseOrderDraftOptions {
  /** Estado actual del formulario que se persiste. */
  draft: OrderDraft;
  /** Usuario dueño del borrador; sin usuario no se lee ni se escribe. */
  userId: string | null | undefined;
  /** Aplica un borrador restaurado a los estados de la página. */
  onRestore: (draft: OrderDraft) => void;
  /** Se invoca sólo si había un borrador guardado (para mostrar el toast). */
  onRestored?: () => void;
  /** Storage alternativo para tests; por defecto `window.localStorage`. */
  storage?: OrderDraftStorage | null;
  /** Debounce de guardado; 400 ms como el alta original. */
  debounceMs?: number;
  /**
   * Desactiva restauración y guardado. La edición de un pedido, o una precarga
   * desde `?fromOrder=`, no debe pisar el borrador local del alta.
   */
  enabled?: boolean;
  /**
   * Permite leer el borrador guardado. Se separa de `enabled` para los flujos
   * que aplican una precarga primero y recién después habilitan el autoguardado
   * sin restaurar el borrador anterior encima del carrito precargado.
   */
  restore?: boolean;
}

function getBrowserStorage(): OrderDraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Modo privado o storage bloqueado: el borrador simplemente no persiste.
    return null;
  }
}

/**
 * Restaura el borrador (cuando `restore` lo permite) y lo guarda con debounce
 * cada vez que cambia el formulario. La carga ocurre una sola vez por usuario;
 * el guardado se salta hasta que terminó la restauración para no pisar el draft
 * con el estado inicial vacío.
 *
 * `enabled` y `restore` se separan para las precargas: primero se aplica el
 * cliente/pedido solicitado y después se habilita el autoguardado, sin volver a
 * restaurar el borrador viejo encima del carrito precargado.
 */
export function useOrderDraft({
  draft,
  userId,
  onRestore,
  onRestored,
  storage,
  debounceMs = 400,
  enabled = true,
  restore = enabled,
}: UseOrderDraftOptions): { clearDraft: () => void } {
  const loadedRef = useRef(false);
  const loadedUserIdRef = useRef<string | null>(null);

  const resolveStorage = useCallback((): OrderDraftStorage | null => {
    return storage !== undefined ? storage : getBrowserStorage();
  }, [storage]);

  useEffect(() => {
    // Sin usuario todavía (sesión cargando) no se toca el storage. Cuando la
    // sesión resuelve, se restaura una sola vez el borrador de ese usuario.
    if (!enabled || !userId) {
      loadedRef.current = false;
      loadedUserIdRef.current = null;
      return;
    }
    if (loadedRef.current && loadedUserIdRef.current === userId) return;

    loadedRef.current = true;
    loadedUserIdRef.current = userId;

    // Una precarga de pedido puede habilitar el guardado sin restaurar el
    // borrador viejo: se marca la carga como resuelta para que el autoguardado
    // empiece a persistir el estado precargado.
    if (!restore) return;

    const saved = loadOrderDraft(resolveStorage(), userId);
    if (saved) {
      onRestore(saved);
      onRestored?.();
    }
  }, [enabled, restore, userId, onRestore, onRestored, resolveStorage]);

  useEffect(() => {
    if (!enabled || !loadedRef.current || !userId || loadedUserIdRef.current !== userId) return;

    const timer = setTimeout(() => {
      saveOrderDraft(
        resolveStorage(),
        {
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
        },
        userId,
      );
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [
    enabled,
    userId,
    draft.quantities,
    draft.selectedClient,
    draft.salesperson,
    draft.comment,
    draft.itemDiscounts,
    draft.generalDiscount,
    draft.brandDiscounts,
    draft.invoiceType,
    draft.paymentCondition,
    draft.paymentConditionDetail,
    debounceMs,
    resolveStorage,
  ]);

  const clearDraft = useCallback(() => {
    if (!userId) return;
    clearOrderDraft(resolveStorage(), userId);
  }, [resolveStorage, userId]);

  return { clearDraft };
}
