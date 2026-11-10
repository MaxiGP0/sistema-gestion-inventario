/** Preferencia local para la vibración táctil (por defecto activada). */
export const HAPTICS_STORAGE_KEY = 'sgi_haptics';

function resolveStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isHapticsEnabled(storage: Storage | null = resolveStorage()): boolean {
  try {
    return storage?.getItem(HAPTICS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setHapticsEnabled(
  enabled: boolean,
  storage: Storage | null = resolveStorage(),
): void {
  try {
    storage?.setItem(HAPTICS_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Sin localStorage la preferencia no persiste entre visitas.
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;

  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * iOS/Safari no implementan la Vibration API. Además, algunos navegadores de
 * escritorio exponen `vibrate` como no-op, así que se evita el efecto ahí.
 */
export function isHapticsSupported(
  navigatorLike: Navigator | null | undefined = typeof navigator === 'undefined' ? null : navigator,
): boolean {
  if (!navigatorLike || typeof navigatorLike.vibrate !== 'function') return false;

  const userAgent = typeof navigatorLike.userAgent === 'string' ? navigatorLike.userAgent : '';
  const isIOS = /iPad|iPhone|iPod/i.test(userAgent);
  // iPadOS se presenta como Macintosh; el touch lo delata.
  const maxTouchPoints = (navigatorLike as Navigator & { maxTouchPoints?: number }).maxTouchPoints;
  const isIPadOS =
    /Macintosh/i.test(userAgent) && typeof maxTouchPoints === 'number' && maxTouchPoints > 1;
  if (isIOS || isIPadOS) return false;

  const isSafari =
    /Safari/i.test(userAgent) &&
    !/(Chrome|CriOS|Chromium|Edg|EdgiOS|OPR|Opera|Firefox|FxiOS)/i.test(userAgent);

  return !isSafari;
}

/**
 * Vibración corta para confirmar un toque. No lanza si la API no existe, si el
 * operario desactivó la preferencia o si pidió movimiento reducido.
 */
export function vibrateOnTap(pattern: number | number[] = 8): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!isHapticsEnabled()) return false;
  if (prefersReducedMotion()) return false;
  if (!isHapticsSupported(navigator)) return false;

  try {
    return navigator.vibrate(pattern);
  } catch {
    return false;
  }
}
