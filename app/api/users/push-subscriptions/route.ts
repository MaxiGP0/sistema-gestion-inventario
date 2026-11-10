import { NextResponse } from 'next/server';
import type { Types } from 'mongoose';
import dbConnect from '@/lib/mongodb';
import { requireCurrentSession } from '@/lib/auth';
import { getVapidConfig } from '@/lib/env';
import { isDuplicateKeyError } from '@/lib/order-idempotency';
import {
  PUSH_SUBSCRIPTION_MAX_PER_USER,
  isExpiredPushSubscriptionError,
  toPushSubscriptionDTO,
  type PushSubscriptionDTO,
} from '@/lib/push-subscriptions';
import {
  pushSubscriptionCreateSchema,
  pushSubscriptionDeleteSchema,
  pushSubscriptionTestSchema,
} from '@/lib/validations';
import { isWebPushConfigured, sendWebPushNotification } from '@/lib/web-push';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { PRIVATE_REVALIDATE_HEADERS } from '@/lib/cache-control';
import type {
  PushSubscriptionDeleteResponse,
  PushSubscriptionListResponse,
  PushSubscriptionRegisterResponse,
  PushSubscriptionTestResponse,
} from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';
import { PushSubscription } from '@/models/PushSubscription';

/**
 * Suscripciones Web Push del usuario autenticado.
 *
 * - GET    lista los dispositivos del usuario y expone la clave pública VAPID.
 * - POST   registra/renueva la suscripción del dispositivo actual.
 * - DELETE revoca un endpoint (`?endpoint=` o body `{ endpoint }`) o todos los
 *          dispositivos (`?all=true` o body `{ all: true }`).
 *
 * Ningún método acepta un `userId` del cliente: siempre opera sobre la sesión
 * firmada. El endpoint es único en la colección y se reasigna si otra persona
 * inicia sesión en el mismo navegador.
 */

interface LeanPushSubscription {
  _id: Types.ObjectId;
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  userAgent?: string | null;
  createdAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
}

function listResponse(subscriptions: PushSubscriptionDTO[]): PushSubscriptionListResponse {
  return {
    success: true,
    subscriptions,
    publicKey: getVapidConfig()?.publicKey ?? null,
    maxSubscriptions: PUSH_SUBSCRIPTION_MAX_PER_USER,
  };
}

async function listSubscriptions(userId: string): Promise<PushSubscriptionDTO[]> {
  const subscriptions = await PushSubscription.find({ userId })
    .select('endpoint userAgent createdAt lastUsedAt')
    .sort({ lastUsedAt: -1, createdAt: -1 })
    .lean<LeanPushSubscription[]>();

  return subscriptions.map(toPushSubscriptionDTO);
}

export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    await dbConnect();

    const subscriptions = await listSubscriptions(auth.session.userId);
    return NextResponse.json(listResponse(subscriptions), {
      headers: PRIVATE_REVALIDATE_HEADERS,
    });
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al listar suscripciones push:' });
  }
});

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, pushSubscriptionCreateSchema);
    if (!parsedBody.success) return parsedBody.response;

    if (!getVapidConfig()) {
      return errorResponse('Web Push no está configurado en el servidor', 503);
    }

    const { endpoint, keys, userAgent } = parsedBody.data;
    const userId = auth.session.userId;

    await dbConnect();

    const existing = await PushSubscription.findOne({ endpoint })
      .select('_id userId')
      .lean<{ _id: unknown; userId: unknown } | null>();

    const alreadyOwnedByUser = Boolean(existing && String(existing.userId) === userId);

    if (!alreadyOwnedByUser) {
      const deviceCount = await PushSubscription.countDocuments({ userId });
      if (deviceCount >= PUSH_SUBSCRIPTION_MAX_PER_USER) {
        return errorResponse(
          `Alcanzaste el límite de ${PUSH_SUBSCRIPTION_MAX_PER_USER} dispositivos. Revocá uno antes de agregar otro.`,
          409,
        );
      }
    }

    const now = new Date();
    const update = {
      $set: {
        userId,
        endpoint,
        keys,
        userAgent: userAgent ?? null,
        lastUsedAt: now,
      },
      $setOnInsert: { createdAt: now },
    };

    let subscription: LeanPushSubscription | null;
    try {
      subscription = await PushSubscription.findOneAndUpdate({ endpoint }, update, {
        upsert: true,
        new: true,
        runValidators: true,
      }).lean<LeanPushSubscription | null>();
    } catch (error: unknown) {
      // Carrera entre dos registros del mismo endpoint: el índice único deja
      // ganar a uno; el otro actualiza el documento ya creado.
      if (!isDuplicateKeyError(error)) throw error;

      subscription = await PushSubscription.findOneAndUpdate({ endpoint }, update, {
        new: true,
        runValidators: true,
      }).lean<LeanPushSubscription | null>();
    }

    if (!subscription) {
      return errorResponse('No se pudo registrar la suscripción push', 500);
    }

    const response: PushSubscriptionRegisterResponse = {
      success: true,
      message: 'Notificaciones push activadas en este dispositivo',
      subscription: toPushSubscriptionDTO(subscription),
      maxSubscriptions: PUSH_SUBSCRIPTION_MAX_PER_USER,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al registrar la suscripción push:',
      duplicateMessages: { endpoint: 'Ese dispositivo ya tiene una suscripción registrada' },
    });
  }
});

type DeleteInput = { endpoint?: string; all?: boolean };

function parseDeleteQuery(url: URL): DeleteInput {
  const params = url.searchParams;
  const rawAll = params.get('all');

  return {
    endpoint: params.get('endpoint') ?? undefined,
    all:
      rawAll === null
        ? undefined
        : rawAll === 'true'
          ? true
          : rawAll === 'false'
            ? false
            : undefined,
  };
}

export const DELETE = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const url = new URL(request.url);
    const hasQueryInput = url.searchParams.has('endpoint') || url.searchParams.has('all');

    let deleteInput: DeleteInput;

    if (hasQueryInput) {
      const rawAll = url.searchParams.get('all');
      if (rawAll !== null && rawAll !== 'true' && rawAll !== 'false') {
        return errorResponse('El campo all debe ser booleano', 400);
      }

      const parsedQuery = pushSubscriptionDeleteSchema.safeParse(parseDeleteQuery(url));
      if (!parsedQuery.success) {
        return errorResponse(parsedQuery.error.issues[0]?.message ?? 'Datos inválidos', 400);
      }
      deleteInput = parsedQuery.data;
    } else {
      const parsedBody = await parseJsonBody(request, pushSubscriptionDeleteSchema);
      if (!parsedBody.success) return parsedBody.response;
      deleteInput = parsedBody.data;
    }

    const { endpoint, all } = deleteInput;
    const userId = auth.session.userId;

    await dbConnect();

    const filter = endpoint ? { userId, endpoint } : { userId };
    const result = endpoint
      ? await PushSubscription.deleteOne(filter)
      : all
        ? await PushSubscription.deleteMany(filter)
        : { deletedCount: 0 };

    const removed = result.deletedCount ?? 0;

    const response: PushSubscriptionDeleteResponse = {
      success: true,
      message:
        removed > 0
          ? `Se revocaron ${removed} ${removed === 1 ? 'suscripción' : 'suscripciones'} push`
          : 'No había suscripciones push para revocar',
      removed,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al revocar la suscripción push:' });
  }
});

export const PATCH = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, pushSubscriptionTestSchema);
    if (!parsedBody.success) return parsedBody.response;

    if (!isWebPushConfigured()) {
      return errorResponse('Web Push no está configurado en el servidor', 503);
    }

    const { endpoint } = parsedBody.data;
    const userId = auth.session.userId;

    await dbConnect();

    const filter = endpoint ? { userId, endpoint } : { userId };
    const subscriptions = await PushSubscription.find(filter)
      .select('_id endpoint keys')
      .lean<LeanPushSubscription[]>();

    const validSubscriptions = subscriptions.filter(
      (subscription) =>
        subscription.endpoint && subscription.keys?.p256dh && subscription.keys.auth,
    );

    if (validSubscriptions.length === 0) {
      return errorResponse(
        'Este dispositivo no tiene una suscripción push activa. Volvé a activarla.',
        404,
      );
    }

    const payload = {
      title: 'Notificación de prueba — Sistema de Gestión de Inventario',
      body: 'Las alertas Web Push funcionan correctamente en este dispositivo.',
      targetRole: 'all' as const,
      url: '/settings/notifications',
    };

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
          console.error('Error al borrar una suscripción push vencida en la prueba:', error);
        }
        continue;
      }

      console.error(
        `Error al enviar Web Push de prueba a ${subscription.endpoint?.slice(0, 80) ?? 'un dispositivo'}:`,
        result.reason,
      );
    }

    if (sent === 0) {
      if (removed > 0) {
        return errorResponse(
          'La suscripción de este dispositivo venció en el navegador. Volvé a activarla.',
          410,
        );
      }

      return errorResponse(
        'El servicio push del navegador rechazó el envío de prueba. Volvé a activar la suscripción.',
        502,
      );
    }

    const response: PushSubscriptionTestResponse = {
      success: true,
      message: 'Notificación de prueba enviada a este dispositivo',
      sent,
      removed,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al enviar notificación push de prueba:' });
  }
});
