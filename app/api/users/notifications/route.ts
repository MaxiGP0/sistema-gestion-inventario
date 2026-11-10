import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { clearSessionCookie, requireCurrentSession } from '@/lib/auth';
import { invalidateCurrentSessionCache } from '@/lib/current-session-cache';
import { User } from '@/models/User';
import {
  defaultNotificationInbox,
  listNotificationsForUser,
  NOTIFICATION_PAGE_SIZE,
} from '@/lib/notifications';
import { decodeNotificationCursor } from '@/lib/notification-cursor';
import { notificationQuerySchema, userNotificationsUpdateSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody, parseQueryParams } from '@/lib/api-errors';
import type {
  NotificationPreferenceResponse,
  UserNotificationDTO,
  UserNotificationListResponse,
} from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * Bandeja del usuario autenticado y sus preferencias.
 *
 * GET  -> notificaciones visibles para el rol del usuario, con `read` y
 *         `readAt` individuales (NotificationRead), más `notificationsEnabled`.
 * PUT  -> activa/desactiva las notificaciones del usuario. Nunca acepta un
 *         userId del cliente: siempre opera sobre la sesión firmada.
 */
export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedQuery = parseQueryParams(request, notificationQuerySchema);
    if (!parsedQuery.success) return parsedQuery.response;

    // `requireCurrentSession` ya leyó (o tomó del caché) el estado actual:
    // username, rol y preferencia salen de ese snapshot, sin otra consulta.
    const user = auth.currentUser;
    if (!user) {
      return clearSessionCookie(errorResponse('Sesión inválida', 401));
    }

    const username = user.username || auth.session.username;
    const role = user.role;
    // El vendedor no puede elegir una bandeja compartida: su vista siempre es
    // `vendor` y el filtro individual se aplica en listNotificationsForUser.
    const inbox =
      role === 'vendedor'
        ? 'vendor'
        : (parsedQuery.data.targetRole ?? defaultNotificationInbox(role));
    const limit = parsedQuery.data.limit ?? NOTIFICATION_PAGE_SIZE;
    const cursor = parsedQuery.data.cursor
      ? decodeNotificationCursor(parsedQuery.data.cursor)
      : null;

    if (parsedQuery.data.cursor && !cursor) {
      return errorResponse('Cursor de paginación inválido', 400);
    }

    const page = await listNotificationsForUser({
      userId: auth.session.userId,
      targetRole: inbox,
      role,
      username,
      limit,
      cursor,
    });

    const response: UserNotificationListResponse = {
      success: true,
      notifications: page.notifications as unknown as UserNotificationDTO[],
      inbox,
      notificationsEnabled: user.notificationsEnabled !== false,
      pagination: {
        mode: 'cursor',
        limit,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      },
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al obtener notificaciones del usuario:' });
  }
});

export const PUT = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, userNotificationsUpdateSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { notificationsEnabled } = parsedBody.data;

    await dbConnect();

    const user = await User.findByIdAndUpdate(
      auth.session.userId,
      { notificationsEnabled },
      { new: true, runValidators: true },
    )
      .select('notificationsEnabled')
      .lean();

    if (!user) {
      return clearSessionCookie(errorResponse('Sesión inválida', 401));
    }

    // El GET de la bandeja y el SSE usan el snapshot de sesión: reflejar el
    // cambio de preferencia de inmediato, sin esperar los 30-60 s del TTL.
    invalidateCurrentSessionCache(auth.session.userId);

    const response: NotificationPreferenceResponse = {
      success: true,
      notificationsEnabled: user.notificationsEnabled !== false,
      message: notificationsEnabled ? 'Notificaciones activadas' : 'Notificaciones desactivadas',
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error al actualizar preferencias de notificaciones:',
    });
  }
});
