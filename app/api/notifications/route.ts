import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole, requireCurrentSession } from '@/lib/auth';
import { resolveUserRole } from '@/lib/authz';
import { Notification } from '@/models/Notification';
import {
  dismissNotificationForUser,
  dismissReadNotificationsForUser,
  listNotificationsForUser,
  NOTIFICATION_PAGE_SIZE,
  setAllNotificationsReadForUser,
  setNotificationReadForUser,
} from '@/lib/notifications';
import {
  notificationCreateSchema,
  notificationDeleteQuerySchema,
  notificationQuerySchema,
  notificationUpdateSchema,
} from '@/lib/validations';
import { handleRouteError, errorResponse, parseJsonBody, parseQueryParams } from '@/lib/api-errors';
import { runAfterResponse } from '@/lib/after-response';
import { decodeNotificationCursor } from '@/lib/notification-cursor';
import { dispatchPushNotification } from '@/lib/push-notifications';
import { broadcastEvent, toSseNotificationPayload } from '@/lib/sse';
import type {
  ApiMessageResponse,
  DeleteResponse,
  NotificationCreateResponse,
  NotificationDTO,
  NotificationListResponse,
  UserNotificationDTO,
} from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * Cola compartida de notificaciones por rol. El estado leído/descartado es
 * individual: cada handler resuelve el usuario de la sesión y delega en
 * `lib/notifications.ts` (ver también `/api/users/notifications`).
 */
export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedQuery = parseQueryParams(request, notificationQuerySchema);
    if (!parsedQuery.success) return parsedQuery.response;

    const { targetRole, limit, cursor: rawCursor } = parsedQuery.data;
    const cursor = rawCursor ? decodeNotificationCursor(rawCursor) : null;

    if (rawCursor && !cursor) {
      return errorResponse('Cursor de paginación inválido', 400);
    }

    await dbConnect();

    const role = resolveUserRole(auth.session.role, auth.session.username);
    const page = await listNotificationsForUser({
      userId: auth.session.userId,
      targetRole,
      role,
      username: auth.session.username,
      limit: limit ?? NOTIFICATION_PAGE_SIZE,
      cursor,
    });

    const response: NotificationListResponse = {
      success: true,
      notifications: page.notifications as unknown as UserNotificationDTO[],
      pagination: {
        mode: 'cursor',
        limit: limit ?? NOTIFICATION_PAGE_SIZE,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      },
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al obtener notificaciones:' });
  }
});

/**
 * Creación manual de notificaciones. Los flujos de pedidos publican sus
 * alertas internamente con `publishOrderNotification`; este endpoint queda
 * reservado al admin para evitar avisos arbitrarios desde otros roles.
 */
export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, notificationCreateSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { title, message, targetRole, targetUserId, targetUsername, orderId } = parsedBody.data;

    await dbConnect();

    const notification = await Notification.create({
      title,
      message,
      targetRole,
      ...(targetUserId ? { targetUserId } : {}),
      ...(targetUsername ? { targetUsername } : {}),
      orderId,
    });

    const eventId = notification?._id ? String(notification._id) : undefined;
    const notificationPayload = notification?._id
      ? toSseNotificationPayload({
          id: notification._id,
          title: notification.title,
          message: notification.message,
          createdAt: notification.createdAt,
          targetRole: notification.targetRole,
          orderId: notification.orderId,
        })
      : undefined;

    runAfterResponse(async () => {
      try {
        broadcastEvent({
          type: 'notification',
          targetRole,
          ...(targetUserId ? { targetUserId: String(targetUserId) } : {}),
          ...(targetUsername ? { targetUsername } : {}),
          ...(orderId ? { orderId: String(orderId) } : {}),
          eventId,
          ...(notificationPayload ? { notification: notificationPayload } : {}),
        });
      } catch (error) {
        console.error(`Error al emitir el evento SSE para ${targetRole}:`, error);
      }

      try {
        await dispatchPushNotification({
          title,
          message,
          targetRole,
          targetUserId: targetUserId ? String(targetUserId) : undefined,
          targetUsername,
          orderId: orderId ? String(orderId) : undefined,
        });
      } catch (error) {
        console.error(`Error al enviar Web Push para ${targetRole}:`, error);
      }
    });

    const response: NotificationCreateResponse = {
      success: true,
      notification: notification as unknown as NotificationDTO,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al crear notificación:' });
  }
});

export const PUT = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, notificationUpdateSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { id, read, targetRole } = parsedBody.data;
    const shouldRead = read !== undefined ? read : true;

    await dbConnect();

    if (id) {
      await setNotificationReadForUser({
        userId: auth.session.userId,
        notificationId: id,
        read: shouldRead,
      });
    } else {
      // "Marcar todas" solo toca la bandeja solicitada (mismo filtro que GET)
      // y solo el estado del usuario autenticado. Para un vendedor el filtro
      // se fuerza a su bandeja privada dentro de lib/notifications.ts.
      await setAllNotificationsReadForUser({
        userId: auth.session.userId,
        targetRole,
        role: resolveUserRole(auth.session.role, auth.session.username),
        username: auth.session.username,
        read: shouldRead,
      });
    }

    const response: ApiMessageResponse = {
      success: true,
      message: 'Notificaciones actualizadas',
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al actualizar notificaciones:' });
  }
});

export const DELETE = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedQuery = parseQueryParams(request, notificationDeleteQuerySchema);
    if (!parsedQuery.success) return parsedQuery.response;

    const { id, targetRole } = parsedQuery.data;

    await dbConnect();

    if (id) {
      // Borrar de la bandeja es un descarte individual: la notificación
      // compartida y el estado de lectura de los demás usuarios no cambian.
      await dismissNotificationForUser({
        userId: auth.session.userId,
        notificationId: id,
      });
    } else {
      // "Limpiar leídas" solo oculta las leídas de esta bandeja para el usuario.
      await dismissReadNotificationsForUser({
        userId: auth.session.userId,
        targetRole,
        role: resolveUserRole(auth.session.role, auth.session.username),
        username: auth.session.username,
      });
    }

    const response: DeleteResponse = {
      success: true,
      message: 'Notificaciones eliminadas correctamente',
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al eliminar notificaciones:' });
  }
});
