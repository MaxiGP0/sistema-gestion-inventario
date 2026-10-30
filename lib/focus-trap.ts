/**
 * Utilidades de accesibilidad para diálogos y widgets navegables con teclado.
 * Se mantienen libres de React para poder probarlas con `node:test`.
 */

/** Selector de los elementos que participan en el orden natural de Tab. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type RovingKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export function isRovingKey(key: string): key is RovingKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/**
 * Devuelve true cuando el elemento no debe recibir foco por estar oculto para
 * la vista o para tecnologías de asistencia.
 */
export function isElementVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;
  const styles = window.getComputedStyle(element);
  return styles.display !== 'none' && styles.visibility !== 'hidden';
}

/** Elementos enfocables y visibles dentro de un contenedor, en orden de Tab. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('disabled') && element.tabIndex >= 0 && isElementVisible(element),
  );
}

/**
 * Calcula el foco que corresponde al envolver Tab/Shift+Tab dentro de un
 * diálogo. Devuelve `null` cuando el navegador puede mover el foco solo (no se
 * está en un extremo).
 */
export function getWrappedFocusIndex(
  currentIndex: number,
  count: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  if (!shiftKey && currentIndex === count - 1) return 0;
  if (shiftKey && currentIndex === 0) return count - 1;
  return null;
}

/**
 * Siguiente índice para un widget con navegación circular (flechas, Home y
 * End). `currentIndex` puede ser -1 si el foco todavía no está en un ítem.
 */
export function getRovingIndex(currentIndex: number, count: number, key: RovingKey): number | null {
  if (count <= 0) return null;

  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
    case 'ArrowUp':
      return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
  }
}
