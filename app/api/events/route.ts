import { connection } from 'next/server';
import { requireCurrentSession, resolveCurrentSessionUser } from '@/lib/auth';
import { notificationInboxForRole } from '@/lib/notification-inbox';
import { SSE_HEADERS, SSE_UNKNOWN_IP, createEventStream } from '@/lib/sse';
import { resolveClientIp } from '@/lib/client-ip';
import { withRouteLogging } from '@/lib/logger';

/**
 * Canal SSE para notificaciones en tiempo real (ver lib/sse.ts y
 * docs/sse-notificaciones.md).
 *
 * La bandeja sale del rol actual del usuario, nunca de un query del cliente:
 * controlador -> deposit, billing -> billing, vendedor -> vendor, admin -> all.
 * Cada cliente mantiene la conexión abierta y solo recibe eventos de su
 * bandeja; en vendor el bus además filtra por `targetUserId`.
 *
 * La conexión se abre con `requireCurrentSession` (usuario activo y
 * `sessionVersion` vigente). El heartbeat de lib/sse.ts vuelve a contrastar
 * ese estado cada 25 s y, si hubo baja/reset/cambio de rol, emite
 * `session-expired` y cierra: el cliente no sigue viendo la bandeja anterior.
 */
export const GET = withRouteLogging(async (request: Request) => {
  const auth = await requireCurrentSession(request);
  if ('response' in auth) return auth.response;

  // Con Cache Components activo, connection() excluye al handler del prerender:
  // el stream tiene que nacer de un request real, no de una respuesta estática.
  await connection();

  const inbox = notificationInboxForRole(auth.session.role);

  const stream = createEventStream({
    userId: auth.session.userId,
    username: auth.session.username,
    inbox,
    sessionVersion: auth.session.sessionVersion,
    verifySession: async () => {
      const current = await resolveCurrentSessionUser(auth.session);
      if (!current) return null;

      return {
        active: current.active,
        sessionVersion: current.sessionVersion,
        // Un cambio de rol invalida la bandeja aunque la versión no cambie.
        inbox: notificationInboxForRole(current.role),
      };
    },
    // Sólo se confían en `x-forwarded-for`/`x-real-ip` si TRUST_PROXY_HEADERS
    // está habilitado; si no, el límite por IP se desactiva y queda el de usuario.
    ip: resolveClientIp(request, SSE_UNKNOWN_IP),
    lastEventId: request.headers.get('last-event-id'),
  });

  return new Response(stream, { headers: SSE_HEADERS });
});
