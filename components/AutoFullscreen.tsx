'use client';

import { useEffect } from 'react';
import { FULLSCREEN_REQUEST_EVENT, requestAppFullscreen } from '@/lib/fullscreen';

/**
 * Pantalla completa sólo por acción explícita (tablets/kioscos de depósito).
 *
 * Antes este componente escuchaba `pointerdown`, `touchend` y `click` en modo
 * captura para pedir `requestFullscreen()` en cada toque. En Android Chrome el
 * teclado virtual saca al navegador de pantalla completa y el siguiente toque
 * sobre un input o botón volvía a entrar: el viewport se redimensionaba a mitad
 * del gesto, se movía el control que el usuario estaba tocando y se cerraba el
 * teclado.
 *
 * La app ya se puede instalar como PWA (`InstallAppButton` + manifest con
 * `display: standalone`), que oculta las barras del navegador sin estos saltos.
 * Si un kiosco necesita entrar a pantalla completa, un control propio puede
 * despachar `FULLSCREEN_REQUEST_EVENT` desde su `onClick`.
 */
export default function AutoFullscreen() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleExplicitRequest = () => {
      const result = requestAppFullscreen();

      // La API puede rechazar la promesa si el navegador no considera el
      // evento como una interacción válida (p. ej. Safari en iPhone).
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined);
      }
    };

    window.addEventListener(FULLSCREEN_REQUEST_EVENT, handleExplicitRequest);

    return () => {
      window.removeEventListener(FULLSCREEN_REQUEST_EVENT, handleExplicitRequest);
    };
  }, []);

  return null;
}
