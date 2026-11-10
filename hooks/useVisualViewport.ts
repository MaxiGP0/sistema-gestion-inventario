'use client';

import { useEffect, useState } from 'react';

export interface VisualViewportMetrics {
  /** Altura visible real en px; `null` hasta que se mide en el cliente. */
  height: number | null;
  /** Paneo del viewport visual respecto del layout (iOS Safari). */
  offsetTop: number;
  /** `true` cuando el teclado virtual redujo el área visible. */
  keyboardOpen: boolean;
}

function getLayoutViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight;
}

function isEditableElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  return element.matches('input, textarea, select') || element.isContentEditable;
}

/**
 * Mide el viewport visible con `window.visualViewport`.
 *
 * En iOS Safari `100vh`/`100dvh` no se achican al abrir el teclado; el
 * visualViewport sí. `offsetTop` compensa además el paneo que Safari aplica
 * para mantener el campo enfocado a la vista. Si la API no existe, las hojas
 * y la página usan `dvh`/`vh` como fallback en CSS.
 */
export function useVisualViewport(enabled = true): VisualViewportMetrics {
  const [metrics, setMetrics] = useState<VisualViewportMetrics>({
    height: null,
    offsetTop: 0,
    keyboardOpen: false,
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame = 0;

    const update = () => {
      frame = 0;
      const height = Math.round(viewport.height);
      const offsetTop = Math.round(viewport.offsetTop);
      // El umbral evita confundir los cambios chicos de la barra del navegador
      // con el teclado virtual.
      const keyboardOpen = height < getLayoutViewportHeight() - 120;

      setMetrics((previous) =>
        previous.height === height &&
        previous.offsetTop === offsetTop &&
        previous.keyboardOpen === keyboardOpen
          ? previous
          : { height, offsetTop, keyboardOpen },
      );
    };

    const scheduleUpdate = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    viewport.addEventListener('resize', scheduleUpdate);
    viewport.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', scheduleUpdate);
      viewport.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [enabled]);

  return metrics;
}

/**
 * Mantiene visible el campo enfocado por encima del teclado y devuelve si hay
 * foco en un campo editable (para ocultar la barra fija inferior).
 *
 * Se escucha `visualViewport.resize` además de `focusin`: en iOS el teclado
 * termina de animarse después del foco, por eso se repite la comprobación.
 * En escritorio el hook no hace nada.
 */
export function useMobileKeyboardFocus(enabled = true): boolean {
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const mobileQuery = window.matchMedia('(max-width: 1023px)');
    const viewport = window.visualViewport;
    let frame = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const revealFocusedField = () => {
      if (!mobileQuery.matches) return;
      const activeElement = document.activeElement;
      if (!isEditableElement(activeElement)) return;

      const visibleHeight = viewport?.height ?? window.innerHeight;
      const visibleTop = viewport?.offsetTop ?? 0;
      const margin = 24;
      const rect = activeElement.getBoundingClientRect();
      const isObscured =
        rect.bottom > visibleTop + visibleHeight - margin || rect.top < visibleTop + margin;

      if (isObscured) {
        activeElement.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    };

    const scheduleReveal = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealFocusedField);
      if (settleTimer) clearTimeout(settleTimer);
      // Margen para el final de la animación del teclado en iOS/Android.
      settleTimer = setTimeout(revealFocusedField, 300);
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!mobileQuery.matches) return;
      if (!isEditableElement(event.target as Element | null)) return;
      setInputFocused(true);
      scheduleReveal();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!mobileQuery.matches) return;
      const nextTarget = event.relatedTarget as Element | null;
      // Pasar de un input a otro no debe mostrar la barra entre medio.
      if (!isEditableElement(nextTarget)) setInputFocused(false);
    };

    // Si el usuario cruza el breakpoint (por ejemplo en DevTools), la barra
    // vuelve a su estado normal al pasar a escritorio.
    const handleBreakpointChange = () => {
      if (!mobileQuery.matches) setInputFocused(false);
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    mobileQuery.addEventListener('change', handleBreakpointChange);
    viewport?.addEventListener('resize', scheduleReveal);
    viewport?.addEventListener('scroll', scheduleReveal);
    window.addEventListener('orientationchange', scheduleReveal);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      mobileQuery.removeEventListener('change', handleBreakpointChange);
      viewport?.removeEventListener('resize', scheduleReveal);
      viewport?.removeEventListener('scroll', scheduleReveal);
      window.removeEventListener('orientationchange', scheduleReveal);
    };
  }, [enabled]);

  // Refleja el foco editable en <html> para que los avisos flotantes que no
  // comparten árbol de React (indicador offline, service worker, toasts) se
  // oculten con CSS mientras el teclado virtual tapa la mitad inferior.
  useEffect(() => {
    const root = document.documentElement;

    if (inputFocused) {
      root.dataset.mobileKeyboard = 'open';
    } else {
      delete root.dataset.mobileKeyboard;
    }

    return () => {
      delete root.dataset.mobileKeyboard;
    };
  }, [inputFocused]);

  return inputFocused;
}
