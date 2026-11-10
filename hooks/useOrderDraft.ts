'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { loadOrderDraft, type OrderDraft, type OrderDraftStorage } from '@/lib/order-draft';
import {
  attachOrderDraftLifecycleFlush,
  createOrderDraftAutosave,
} from '@/lib/order-draft-autosave';

interface UseOrderDraftOptions {
  /** Estado actual del formulario que se persiste. */
  draft: OrderDraft;
  /** Usuario dueño del borrador; sin usuario no se lee ni se escribe. */
  userId: string | null | undefined;
  /** Pedido en edición (`mode="edit"`); aísla la clave por pedido. */
  orderId?: string | null;
  /** Versión del borrador cuando se abrió la edición; exige coincidencia al restaurar. */
  version?: number;
  /** Aplica un borrador restaurado a los estados de la página. */
  onRestore: (draft: OrderDraft) => void;
  /** Se invoca sólo si había un borrador guardado (para mostrar el toast). */
  onRestored?: () => void;
  /** Storage alternativo para tests; por defecto `window.localStorage`. */
  storage?: OrderDraftStorage | null;
  /** Debounce de guardado; 400 ms como el alta original. */
  debounceMs?: number;
  /**
   * Desactiva restauración y guardado hasta que termine la precarga inicial.
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
 *
 * `flush()` escribe ya mismo el último cambio (sin esperar el debounce) y lo
 * usan `pagehide`/`visibilitychange` para no perder trabajo al cerrar o cambiar
 * de app en el teléfono.
 */
export function useOrderDraft({
  draft,
  userId,
  orderId,
  version,
  onRestore,
  onRestored,
  storage,
  debounceMs = 400,
  enabled = true,
  restore = enabled,
}: UseOrderDraftOptions): { clearDraft: () => void; flush: () => boolean } {
  const loadedRef = useRef(false);
  const loadedScopeRef = useRef<string | null>(null);

  const resolveStorage = useCallback((): OrderDraftStorage | null => {
    return storage !== undefined ? storage : getBrowserStorage();
  }, [storage]);

  const scopeKey = useMemo(() => {
    if (!userId || !userId.trim()) return null;
    if (orderId !== undefined && orderId !== null) {
      if (!orderId.trim()) return null;
      return `${userId.trim()}:edit:${orderId.trim()}:${version ?? ''}`;
    }
    return userId.trim();
  }, [orderId, userId, version]);

  const autosave = useMemo(
    () =>
      createOrderDraftAutosave({
        storage: resolveStorage(),
        userId,
        orderId,
        version,
        debounceMs,
        enabled,
      }),
    [debounceMs, enabled, orderId, resolveStorage, userId, version],
  );

  useEffect(() => {
    // Sin usuario todavía (sesión cargando) no se toca el storage. Cuando la
    // sesión resuelve, se restaura una sola vez el borrador de ese alcance.
    if (!enabled || !userId || !scopeKey) {
      loadedRef.current = false;
      loadedScopeRef.current = null;
      autosave.cancel();
      return;
    }
    if (loadedRef.current && loadedScopeRef.current === scopeKey) return;

    loadedRef.current = true;
    loadedScopeRef.current = scopeKey;

    // Una precarga de pedido puede habilitar el guardado sin restaurar el
    // borrador viejo: se toma el estado precargado como base para que el
    // autoguardado empiece a persistir cambios reales.
    if (!restore) {
      autosave.setBaseline(draft);
      return;
    }

    const saved = loadOrderDraft(resolveStorage(), userId, { orderId, version });
    if (saved) {
      autosave.setRestoredBaseline(saved);
      onRestore(saved);
      onRestored?.();
    } else {
      autosave.setBaseline(draft);
    }
  }, [
    autosave,
    draft,
    enabled,
    orderId,
    restore,
    scopeKey,
    userId,
    version,
    onRestore,
    onRestored,
    resolveStorage,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !loadedRef.current ||
      !userId ||
      !scopeKey ||
      loadedScopeRef.current !== scopeKey
    ) {
      autosave.cancel();
      return;
    }

    autosave.schedule(draft);

    return () => autosave.cancel();
  }, [autosave, enabled, scopeKey, userId, draft]);

  const flush = useCallback(() => {
    if (!enabled || !userId || !scopeKey) return false;
    return autosave.flush();
  }, [autosave, enabled, scopeKey, userId]);

  useEffect(() => {
    return attachOrderDraftLifecycleFlush(flush);
  }, [flush]);

  const clearDraft = useCallback(() => {
    autosave.clear();
  }, [autosave]);

  return { clearDraft, flush };
}
