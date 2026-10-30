'use client';

/**
 * Utilidades de Web Push para el navegador.
 *
 * Centraliza la detección de soporte, el permiso y la suscripción del
 * dispositivo. Nunca pide permiso al importarse o al montar una pantalla: la
 * llamada a `Notification.requestPermission()` queda en la acción explícita
 * del botón (ver `components/PushNotificationsCard.tsx`).
 */

export type PushCapability = 'supported' | 'unsupported' | 'ios-requires-install';

export interface BrowserPushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** ¿El navegador tiene las APIs necesarias para Web Push? */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** iPhone/iPad, incluido iPadOS que se presenta como macOS con touch. */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;

  return (
    navigator.platform === 'MacIntel' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  );
}

/** ¿El navegador actual es Firefox (Android, iOS o escritorio)? */
export function isFirefoxBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Firefox|FxiOS/i.test(navigator.userAgent || '');
}

/** ¿La app corre instalada (standalone) y no como pestaña del navegador? */
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;

  const standalone =
    (window.matchMedia?.('(display-mode: standalone)')?.matches ?? false) ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

  return Boolean(standalone);
}

/**
 * iOS/iPadOS solo habilita Web Push con la PWA agregada a la pantalla de
 * inicio. En el navegador embebido o en una pestaña normal no hay PushManager.
 */
export function getPushCapability(): PushCapability {
  if (!isPushSupported()) {
    return isIosDevice() && !isStandalonePwa() ? 'ios-requires-install' : 'unsupported';
  }

  if (isIosDevice() && !isStandalonePwa()) return 'ios-requires-install';

  return 'supported';
}

/** Permiso actual del navegador (`unsupported` si no hay API). */
export function getPushPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

/** Normaliza base64 estándar o con padding (`=`) a base64url sin padding. */
export function normalizeUrlBase64(value: string): string {
  return value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Convierte un `ArrayBuffer` (como el que devuelve `getKey()`) a base64url. */
export function arrayBufferToUrlBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return normalizeUrlBase64(btoa(binary));
}

/**
 * Convierte la clave pública VAPID (base64url) al `Uint8Array` que espera
 * `PushManager.subscribe`. Es pura para poder probarla sin navegador.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const normalized = base64Url.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function sameApplicationServerKey(subscription: PushSubscription, publicKey: string): boolean {
  const currentKey = subscription.options?.applicationServerKey;
  if (!currentKey) return true;

  const expected = urlBase64ToUint8Array(publicKey);
  const current = new Uint8Array(currentKey);
  if (current.length !== expected.length) return false;

  return current.every((byte, index) => byte === expected[index]);
}

/**
 * Espera la registración activa del service worker.
 *
 * En Firefox y Chrome, `pushManager.subscribe()` falla con `InvalidStateError`
 * si el worker todavía está en `installing` (`registration.active === null`).
 * Además, si hay un worker en `waiting` (por ejemplo, tras desplegar el soporte
 * de Web Push), le pide `SKIP_WAITING` para que el worker activo tenga el
 * listener `push`.
 */
export async function getServiceWorkerRegistration(
  timeoutMs = 10_000,
): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Este navegador no soporta service workers');
  }

  let registration =
    (await navigator.serviceWorker.getRegistration('/')) ??
    (await navigator.serviceWorker.getRegistration());

  if (!registration && typeof navigator.serviceWorker.register === 'function') {
    try {
      const buildId = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';
      registration = await navigator.serviceWorker.register(
        `/sw.js?v=${encodeURIComponent(buildId)}`,
        {
          scope: '/',
          updateViaCache: 'none',
        },
      );
    } catch {
      // Si falla el registro directo, se intenta esperar a `ready` abajo.
    }
  }

  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  if (registration?.active && !registration.waiting) {
    return registration;
  }

  if (navigator.serviceWorker.ready) {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise<ServiceWorkerRegistration>((_, reject) => {
        window.setTimeout(
          () => reject(new Error('El service worker no está disponible')),
          timeoutMs,
        );
      }),
    ]);
  }

  if (registration) return registration;
  throw new Error('El service worker no está disponible');
}

/** Suscripción push actual del navegador, o `null` si no hay ninguna. */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;

  try {
    const registration = await getServiceWorkerRegistration();
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Crea o reutiliza la suscripción del dispositivo para la clave VAPID dada.
 * Si había una suscripción con otra clave, la reemplaza.
 */
export async function subscribeCurrentDevice(publicKey: string): Promise<PushSubscription> {
  const registration = await getServiceWorkerRegistration();
  const existing = await registration.pushManager.getSubscription();

  if (existing) {
    if (sameApplicationServerKey(existing, publicKey)) return existing;
    await existing.unsubscribe();
  }

  const subscribeOptions = {
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  };

  try {
    return await registration.pushManager.subscribe(subscribeOptions);
  } catch (error) {
    // En Firefox `options.applicationServerKey` puede no estar expuesta y
    // `subscribe()` falla si había una suscripción previa con otra clave.
    const stale = await registration.pushManager.getSubscription();
    if (!stale) throw error;

    await stale.unsubscribe();
    return registration.pushManager.subscribe(subscribeOptions);
  }
}

/** Desuscribe el dispositivo. No borra todavía la fila del servidor. */
export async function unsubscribeCurrentDevice(): Promise<string | null> {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) return null;

  const { endpoint } = subscription;
  await subscription.unsubscribe();
  return endpoint;
}

/** Convierte la suscripción del navegador al body del POST. */
export function toBrowserPushSubscriptionPayload(
  subscription: PushSubscription,
): BrowserPushSubscriptionPayload {
  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : {};
  const endpoint = json.endpoint ?? subscription.endpoint;

  const rawP256dh =
    json.keys?.p256dh ||
    (typeof subscription.getKey === 'function' && subscription.getKey('p256dh')
      ? arrayBufferToUrlBase64(subscription.getKey('p256dh') as ArrayBuffer)
      : undefined);

  const rawAuth =
    json.keys?.auth ||
    (typeof subscription.getKey === 'function' && subscription.getKey('auth')
      ? arrayBufferToUrlBase64(subscription.getKey('auth') as ArrayBuffer)
      : undefined);

  const p256dh = rawP256dh ? normalizeUrlBase64(rawP256dh) : undefined;
  const auth = rawAuth ? normalizeUrlBase64(rawAuth) : undefined;

  if (!endpoint || !p256dh || !auth) {
    throw new Error('El navegador no devolvió las claves de la suscripción push');
  }

  return { endpoint, keys: { p256dh, auth } };
}
