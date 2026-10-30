/**
 * Dispatcher de Web Push para las notificaciones de pedidos.
 *
 * Corre después de persistir la notificación y de emitir el SSE, fuera del
 * camino crítico de la respuesta (ver `lib/order-side-effects.ts`). Política:
 *
 * - solo recibe push el rol destinatario de la notificación;
 * - se omiten usuarios inactivos y con `notificationsEnabled === false`;
 * - un fallo de un dispositivo no afecta a los demás ni al alta del pedido;
 * - una respuesta 404/410 del servicio push borra la suscripción vencida.
 *
 * Nunca lanza: si la base o VAPID fallan, el error queda en el log y la
 * respuesta del pedido ya enviada no se modifica.
 */

import type { Types } from 'mongoose';
import { User } from '@/models/User';
import { PushSubscription } from '@/models/PushSubscription';
import { resolveUserRole, USER_ROLES, type UserRole } from './authz';
import {
  buildPushNotificationPayload,
  type PushNotificationInput,
  type PushNotificationPayload,
} from './push-payload';
import { isExpiredPushSubscriptionError } from './push-subscriptions';
import { isWebPushConfigured, sendWebPushNotification } from './web-push';
import type { NotificationTargetRole } from './types/notification';

interface LeanRecipient {
  _id: Types.ObjectId;
  role?: unknown;
  username?: string;
}

interface LeanSubscription {
  _id: Types.ObjectId;
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
}

export interface PushDispatchResult {
  /** Usuarios que corresponden al rol destinatario y tienen la preferencia activa. */
  recipients: number;
  /** Suscripciones encontradas para esos usuarios (puede haber varias por usuario). */
  subscriptions: number;
  sent: number;
  removed: number;
  skipped: 'not-configured' | 'no-recipients' | 'no-subscriptions' | null;
}

/**
 * Roles que reciben push para cada bandeja. El controlador cubre el rol
 * histórico `deposit`; `admin` supervisa ambas bandejas (igual que en la
 * campana y en SSE). `vendor` se acota al destinatario individual en
 * `findPushRecipients`; `all` es una alerta global y se envía a todos los roles.
 */
export function pushRecipientRoles(targetRole: NotificationTargetRole): readonly UserRole[] {
  if (targetRole === 'deposit') return ['admin', 'controlador'];
  if (targetRole === 'billing') return ['admin', 'billing'];
  if (targetRole === 'vendor') return ['admin', 'vendedor'];
  return USER_ROLES;
}

const EMPTY_RESULT: PushDispatchResult = {
  recipients: 0,
  subscriptions: 0,
  sent: 0,
  removed: 0,
  skipped: null,
};

/**
 * Usuarios activos con la preferencia activa cuyo rol recibe la notificación.
 * La consulta trae todos los usuarios del equipo (son pocos) y resuelve el rol
 * en memoria para cubrir documentos históricos sin `role` o con `deposit`.
 *
 * En `vendor` la alerta es privada: además del rol se exige el destinatario
 * individual (`targetUserId` o, para compatibilidad, `targetUsername`). Los
 * admins siguen recibiéndola para supervisar todas las bandejas.
 */
export async function findPushRecipients(
  targetRole: NotificationTargetRole,
  {
    targetUserId,
    targetUsername,
  }: {
    targetUserId?: string | null;
    targetUsername?: string | null;
  } = {},
): Promise<Array<{ userId: string; role: UserRole }>> {
  const users = await User.find({
    active: { $ne: false },
    notificationsEnabled: { $ne: false },
  })
    .select('_id role username')
    .lean<LeanRecipient[]>();

  const allowedRoles = new Set<UserRole>(pushRecipientRoles(targetRole));

  return users
    .map((user) => ({
      userId: String(user._id),
      username: user.username ?? '',
      role: resolveUserRole(user.role, user.username),
    }))
    .filter((user) => allowedRoles.has(user.role))
    .filter((user) => {
      if (targetRole !== 'vendor') return true;
      if (user.role === 'admin') return true;
      if (targetUserId) return user.userId === targetUserId;
      if (targetUsername) return user.username === targetUsername;
      // Sin destinatario no hay vendedor al que enviar: la alerta privada no
      // se difunde a toda la bandeja.
      return false;
    })
    .map(({ userId, role }) => ({ userId, role }));
}

/**
 * Envía el push a todos los dispositivos de los destinatarios.
 *
 * El envío por dispositivo es independiente. Los errores 404/410 se consideran
 * suscripciones vencidas y se borran; el resto solo se registra.
 */
export async function dispatchPushNotification(
  input: PushNotificationInput,
): Promise<PushDispatchResult> {
  const payload: PushNotificationPayload = buildPushNotificationPayload(input);

  try {
    if (!isWebPushConfigured()) {
      return { ...EMPTY_RESULT, skipped: 'not-configured' };
    }

    const recipients = await findPushRecipients(input.targetRole, {
      targetUserId: input.targetUserId,
      targetUsername: input.targetUsername,
    });
    if (recipients.length === 0) {
      return { ...EMPTY_RESULT, skipped: 'no-recipients' };
    }

    const userIds = recipients.map((recipient) => recipient.userId);
    const subscriptions = await PushSubscription.find({ userId: { $in: userIds } })
      .select('_id endpoint keys')
      .lean<LeanSubscription[]>();

    const validSubscriptions = subscriptions.filter(
      (subscription) =>
        subscription.endpoint && subscription.keys?.p256dh && subscription.keys.auth,
    );

    if (validSubscriptions.length === 0) {
      return {
        ...EMPTY_RESULT,
        recipients: recipients.length,
        skipped: 'no-subscriptions',
      };
    }

    let sent = 0;
    let removed = 0;

    const results = await Promise.allSettled(
      validSubscriptions.map(async (subscription) => {
        await sendWebPushNotification(
          {
            endpoint: subscription.endpoint as string,
            keys: {
              p256dh: subscription.keys?.p256dh as string,
              auth: subscription.keys?.auth as string,
            },
          },
          payload,
        );

        await PushSubscription.updateOne(
          { _id: subscription._id },
          { $set: { lastUsedAt: new Date() } },
        );
        return true;
      }),
    );

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        sent += 1;
        continue;
      }

      const subscription = validSubscriptions[index];

      if (isExpiredPushSubscriptionError(result.reason)) {
        try {
          await PushSubscription.deleteOne({ _id: subscription._id });
          removed += 1;
        } catch (error) {
          console.error('Error al borrar una suscripción push vencida:', error);
        }
        continue;
      }

      console.error(
        `Error al enviar Web Push a ${subscription.endpoint?.slice(0, 80) ?? 'un dispositivo'}:`,
        result.reason,
      );
    }

    return {
      recipients: recipients.length,
      subscriptions: validSubscriptions.length,
      sent,
      removed,
      skipped: null,
    };
  } catch (error) {
    console.error('Error en el dispatcher de Web Push:', error);
    return { ...EMPTY_RESULT, skipped: null };
  }
}
