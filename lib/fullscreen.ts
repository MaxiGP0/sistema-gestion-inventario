/**
 * Pantalla completa explícita para kioscos/tablets de depósito.
 *
 * La app se instala como PWA (`manifest` con `display: standalone`), así que
 * el navegador ya oculta sus barras al abrirla instalada. Pedir
 * `requestFullscreen()` en cada toque redimensionaba el viewport en medio del
 * gesto y competía con el teclado virtual; por eso no hay listeners globales de
 * `pointerdown`/`touchend`/`click`.
 *
 * Un control explícito (por ejemplo, un botón de kiosco) puede despachar
 * `FULLSCREEN_REQUEST_EVENT` y `AutoFullscreen` ejecuta la solicitud.
 */

/** Evento que solicita pantalla completa desde una acción explícita. */
export const FULLSCREEN_REQUEST_EVENT = 'sgi:request-fullscreen';

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenCapableDocument = Document & {
  webkitFullscreenElement?: Element | null;
};

/** Indica si el documento ya está en pantalla completa (estándar o WebKit). */
export function isAppFullscreen(doc: Document = document): boolean {
  const fullscreenDocument = doc as FullscreenCapableDocument;
  return Boolean(doc.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement);
}

/**
 * Pide pantalla completa para todo el documento. Devuelve `null` si la API no
 * existe o si ya estaba en pantalla completa. El llamador debe invocarla desde
 * una interacción del usuario (requisito de los navegadores).
 */
export function requestAppFullscreen(doc: Document = document): Promise<void> | void | null {
  if (isAppFullscreen(doc)) return null;

  const element = doc.documentElement as FullscreenCapableElement;

  if (typeof element.requestFullscreen === 'function') {
    try {
      return element.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      return null;
    }
  }

  if (typeof element.webkitRequestFullscreen === 'function') {
    try {
      return element.webkitRequestFullscreen();
    } catch {
      return null;
    }
  }

  return null;
}
