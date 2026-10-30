'use client';

import { useEffect, useRef } from 'react';
import { subscribeCatalogFocus } from '@/lib/catalog-query-cache';

/**
 * Ejecuta `onRevalidate` cuando la pestaña vuelve a foco/visibilidad. La caché
 * de catálogo ya se invalida antes de avisar, así que el callback puede volver
 * a pedir los mismos datos y recibir valores frescos.
 *
 * El callback se guarda en un ref para no reinstalar el listener en cada
 * render (y para que el evento use siempre la versión más reciente).
 */
export function useCatalogFocusRevalidation(onRevalidate: () => void): void {
  const callbackRef = useRef(onRevalidate);

  useEffect(() => {
    callbackRef.current = onRevalidate;
  }, [onRevalidate]);

  useEffect(() => subscribeCatalogFocus(() => callbackRef.current()), []);
}
