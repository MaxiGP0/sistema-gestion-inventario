'use client';

import { useEffect, useRef } from 'react';
import { subscribeCatalogFocus } from '@/lib/catalog-query-cache';

/**
 * Ejecuta `onRevalidate` cuando la pestaña vuelve a foco/visibilidad y la
 * caché de catálogo quedó vieja (ausencia >30 s o TTL vencido). Si la vista
 * sigue mostrando datos frescos, la caché no avisa y no se disparan búsquedas.
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
