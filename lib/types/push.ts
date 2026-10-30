import type { PushSubscriptionDTO } from '@/lib/push-subscriptions';
import type { ApiMessageResponse } from './common';

export type { PushSubscriptionDTO };

/** `GET /api/users/push-subscriptions` */
export interface PushSubscriptionListResponse {
  success: true;
  subscriptions: PushSubscriptionDTO[];
  /** Clave pública VAPID, o `null` si el servidor no tiene Web Push configurado. */
  publicKey: string | null;
  maxSubscriptions: number;
}

/** `POST /api/users/push-subscriptions` */
export interface PushSubscriptionRegisterResponse extends ApiMessageResponse {
  subscription: PushSubscriptionDTO;
  maxSubscriptions: number;
}

/** `DELETE /api/users/push-subscriptions` */
export interface PushSubscriptionDeleteResponse extends ApiMessageResponse {
  removed: number;
}

/** `PATCH /api/users/push-subscriptions` (envío de notificación de prueba) */
export interface PushSubscriptionTestResponse extends ApiMessageResponse {
  sent: number;
  removed: number;
}
