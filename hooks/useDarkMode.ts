'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'sgi_theme';

let cached: boolean | null = null;
const listeners = new Set<() => void>();

function readStoredDarkMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark';
  } catch {
    return false;
  }
}

// getSnapshot debe devolver un valor cacheado: `cached` sólo cambia a través
// de setDarkMode o del evento `storage` de otras pestañas.
function getSnapshot(): boolean {
  if (cached === null) cached = readStoredDarkMode();
  return cached;
}

function getServerSnapshot(): boolean {
  return false;
}

function applyDomTheme(dark: boolean): void {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cached = readStoredDarkMode();
    applyDomTheme(cached);
    emit();
  };

  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setDarkMode(next: boolean): void {
  if (cached === next) return;
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
  } catch {
    // localStorage puede no estar disponible (modo privado): seguimos en memoria.
  }
  applyDomTheme(next);
  emit();
}

/**
 * Tema oscuro compartido por toda la app.
 *
 * Las clases oscuras viven en el CSS (`dark:` con `@custom-variant` sobre
 * `[data-theme=dark]`), así que el HTML del servidor ya las incluye. El script
 * inline de `app/layout.tsx` marca `data-theme="dark"` antes del primer paint
 * cuando corresponde, por lo que no hay flash ni markup distinto que hidratar.
 *
 * - Durante la hidratación devuelve `getServerSnapshot()` (= claro) para que
 *   el primer render coincida con el HTML y no haya error de hidratación.
 * - Después de hidratar, React re-renderiza con el valor real, que sólo se usa
 *   para el ícono del toggle (el tema visual lo controla el atributo del DOM).
 */
export function useDarkMode(): [boolean, (next: boolean) => void] {
  const darkMode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useLayoutEffect(() => {
    // Re-aplica el tema al DOM (en dev, StrictMode resetea los atributos de
    // <html> que no controla React).
    applyDomTheme(getSnapshot());
  }, [darkMode]);

  return [darkMode, setDarkMode];
}
