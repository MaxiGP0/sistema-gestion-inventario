/**
 * Utilidades de instalación de la PWA compartidas por el botón del panel y
 * las pruebas.
 *
 * El evento `beforeinstallprompt` no existe en el DOM estándar de TypeScript:
 * Chrome lo agrega en tiempo de ejecución. La interfaz de acá refleja el
 * contrato que usa el navegador para poder tipar el componente sin `any`.
 */

/** Clave de localStorage para no volver a ofrecer la instalación tras cerrarla. */
export const INSTALL_DISMISSED_STORAGE_KEY = 'sgi_install_dismissed';

export type InstallOutcome = 'accepted' | 'dismissed';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  readonly userChoice: Promise<{ outcome: InstallOutcome; platform: string }>;
  prompt: () => Promise<void>;
}

export type InstallBannerState = 'hidden' | 'prompt' | 'ios-help';

/** Consultas de modo de visualización que indican que la app ya está instalada. */
export const INSTALLED_DISPLAY_MODE_QUERIES = [
  '(display-mode: standalone)',
  '(display-mode: fullscreen)',
  '(display-mode: minimal-ui)',
] as const;

type MatchMediaLike = (query: string) => Pick<MediaQueryList, 'matches'> | null | undefined;

/**
 * Detecta si la app se está ejecutando como PWA instalada. Además de
 * `standalone` se cubren `fullscreen` y `minimal-ui`, porque el manifiesto
 * usa `display_override` y el navegador puede abrir la app en esos modos.
 */
export function isStandaloneDisplayMode(
  matchMedia?: MatchMediaLike | null,
  navigatorStandalone?: boolean,
): boolean {
  if (navigatorStandalone === true) return true;
  if (!matchMedia) return false;

  return INSTALLED_DISPLAY_MODE_QUERIES.some((query) => Boolean(matchMedia(query)?.matches));
}

/**
 * Detecta iPhone/iPad/iPod. iPadOS 13+ se presenta como Macintosh, pero se
 * distingue por la cantidad de puntos táctiles.
 */
export function isIosDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iphone|ipad|ipod/i.test(userAgent)) return true;

  return /macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Indica si el usuario ya cerró el aviso en este dispositivo. */
export function isInstallDismissed(storage?: Pick<Storage, 'getItem'> | null): boolean {
  if (!storage) return false;

  try {
    return storage.getItem(INSTALL_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    // Safari privado o almacenamiento bloqueado: se comporta como no descartado.
    return false;
  }
}

/** Persiste el cierre del aviso; si el almacenamiento falla, no rompe la UI. */
export function dismissInstall(storage?: Pick<Storage, 'setItem'> | null): void {
  if (!storage) return;

  try {
    storage.setItem(INSTALL_DISMISSED_STORAGE_KEY, '1');
  } catch {
    // Sin almacenamiento disponible el aviso se oculta igual durante la sesión.
  }
}

/**
 * Define qué mostrar en el panel: nada (instalada o descartada), el botón de
 * instalación (cuando el navegador disparó `beforeinstallprompt`) o la ayuda
 * manual de iOS/Safari, donde ese evento no existe.
 */
export function getInstallBannerState(input: {
  installed: boolean;
  dismissed: boolean;
  hasPrompt: boolean;
  ios: boolean;
}): InstallBannerState {
  if (input.installed || input.dismissed) return 'hidden';
  if (input.hasPrompt) return 'prompt';
  if (input.ios) return 'ios-help';

  return 'hidden';
}

/**
 * Ejecuta el diálogo nativo de instalación. El navegador sólo permite llamar
 * a `prompt()` una vez por evento, por eso el componente descarta el evento
 * después de usarlo.
 */
export async function promptInstall(event: BeforeInstallPromptEvent): Promise<InstallOutcome> {
  await event.prompt();
  const choice = await event.userChoice;

  return choice.outcome;
}
