/**
 * Constantes y helpers puros de Web Push (sin Node ni acceso a la base).
 *
 * Se pueden importar desde el route handler, el dispatcher, la pantalla de
 * preferencias y los tests. La clave privada VAPID no vive acá.
 */

/** Tope de dispositivos/navegadores suscriptos por usuario. */
export const PUSH_SUBSCRIPTION_MAX_PER_USER = 5;

/** TTL del mensaje en el servicio push si el dispositivo está apagado. */
export const PUSH_NOTIFICATION_TTL_SECONDS = 24 * 60 * 60;

export interface PushSubscriptionDTO {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
}

interface LeanPushSubscription {
  _id: unknown;
  endpoint?: string;
  userAgent?: string | null;
  createdAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** DTO seguro para la API: no incluye las claves de cifrado. */
export function toPushSubscriptionDTO(subscription: LeanPushSubscription): PushSubscriptionDTO {
  return {
    id: String(subscription._id),
    endpoint: subscription.endpoint ?? '',
    userAgent: subscription.userAgent ?? null,
    createdAt: toIsoString(subscription.createdAt) ?? '',
    lastUsedAt: toIsoString(subscription.lastUsedAt) ?? '',
  };
}

/**
 * El servicio push responde 404/410 cuando la suscripción dejó de existir
 * (navegador desinstalado, permiso revocado, endpoint vencido). Esas filas se
 * borran en el dispatcher; otros errores solo se registran.
 */
export function isExpiredPushSubscriptionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return statusCode === 404 || statusCode === 410;
}
