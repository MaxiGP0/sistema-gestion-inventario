'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { getFocusableElements, getWrappedFocusIndex } from '@/lib/focus-trap';

interface UseFocusTrapOptions {
  /** El diálogo está montado y visible. */
  active: boolean;
  /** Se invoca al presionar Escape (el llamador decide si puede cerrarse). */
  onEscape?: () => void;
  /** Elemento que recibe el foco inicial; por defecto, el primero enfocable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Devuelve el foco al elemento que estaba activo antes de abrir (default: true). */
  restoreFocus?: boolean;
}

/**
 * Atrapa el foco dentro de un diálogo y lo restaura al cerrarse.
 *
 * - Tab y Shift+Tab circulan por los elementos enfocables del contenedor.
 * - Escape delega en `onEscape` para que el llamador aplique sus reglas
 *   (por ejemplo, no cerrar mientras una acción está en curso).
 * - Al desactivarse, el foco vuelve al disparador si sigue en el DOM.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { active, onEscape, initialFocusRef, restoreFocus = true }: UseFocusTrapOptions,
): void {
  const onEscapeRef = useRef(onEscape);
  const initialFocusRefRef = useRef(initialFocusRef);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    initialFocusRefRef.current = initialFocusRef;
  }, [initialFocusRef]);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Permite enfocar el propio contenedor cuando no hay controles internos.
    const hadTabIndex = container.hasAttribute('tabindex');
    if (!hadTabIndex) container.setAttribute('tabindex', '-1');

    const focusInitial = () => {
      const target =
        initialFocusRefRef.current?.current ?? getFocusableElements(container)[0] ?? container;
      target.focus();
    };

    // Espera al commit para que el diálogo ya esté en el DOM y con tamaños.
    const frame = requestAnimationFrame(focusInitial);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        onEscapeRef.current?.();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const currentIndex = activeElement ? focusables.indexOf(activeElement) : -1;
      const targetIndex = getWrappedFocusIndex(currentIndex, focusables.length, event.shiftKey);

      if (targetIndex !== null) {
        event.preventDefault();
        focusables[targetIndex].focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      if (!hadTabIndex) container.removeAttribute('tabindex');
      if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [active, containerRef, restoreFocus]);
}
