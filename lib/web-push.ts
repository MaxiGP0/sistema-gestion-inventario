/**
 * Envío de Web Push (solo servidor).
 *
 * `web-push` usa APIs de Node y firma con la clave privada VAPID, así que este
 * módulo nunca debe importarse desde un componente cliente. Si las variables
 * VAPID no están configuradas, `configureWebPush()` devuelve `null` y el
 * dispatcher no envía nada: la app sigue funcionando con SSE + polling.
 */

import webpush from 'web-push';
import { getVapidConfig } from './env';
import { PUSH_NOTIFICATION_TTL_SECONDS } from './push-subscriptions';

export interface WebPushTarget {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface WebPushRequestOptions {
  TTL: number;
  urgency: 'high' | 'normal' | 'low';
}

/**
 * Indirección mínima sobre `web-push` para poder sustituir el envío en los
 * tests sin levantar un servidor push real.
 */
export const webPushSender = {
  send(target: WebPushTarget, payload: string, options: WebPushRequestOptions): Promise<unknown> {
    return webpush.sendNotification(target, payload, options);
  },
};

let configuredFingerprint = '';

/**
 * Configura VAPID una sola vez por combinación de claves. Devuelve `false`
 * cuando Web Push no está configurado en el entorno.
 */
export function configureWebPush(): boolean {
  const config = getVapidConfig();
  if (!config) return false;

  const fingerprint = `${config.subject}\u0000${config.publicKey}\u0000${config.privateKey}`;
  if (fingerprint !== configuredFingerprint) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    configuredFingerprint = fingerprint;
  }

  return true;
}

/** ¿El servidor tiene VAPID configurado? (No expone la clave privada). */
export function isWebPushConfigured(): boolean {
  return configureWebPush();
}

/** Envía un payload JSON a una suscripción. Propaga el error del servicio push. */
export async function sendWebPushNotification(
  target: WebPushTarget,
  payload: unknown,
): Promise<void> {
  if (!configureWebPush()) {
    throw new Error('Web Push no está configurado (faltan variables VAPID)');
  }

  await webPushSender.send(target, JSON.stringify(payload), {
    TTL: PUSH_NOTIFICATION_TTL_SECONDS,
    urgency: 'high',
  });
}
