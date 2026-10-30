import { connection } from 'next/server';
import { requireSession } from '@/lib/auth';
import { notificationInboxForRole } from '@/lib/notification-inbox';
import { SSE_HEADERS, SSE_UNKNOWN_IP, createEventStream } from '@/lib/sse';
import { withRouteLogging } from '@/lib/logger';

/**
 * IP del cliente para el límite de conexiones. Se confía en las cabeceras del
 * proxy inverso (el primer salto de `x-forwarded-for` o `x-real-ip`); si no
 * hay ninguna, el límite por IP se desactiva y queda solo el límite por
 * usuario, que siempre existe en una sesión válida.
 */
function resolveClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstHop = forwardedFor.split(',')[0]?.trim();
    if (firstHop) return firstHop;
  }

  return request.headers.get('x-real-ip')?.trim() || SSE_UNKNOWN_IP;
}

/**
 * Canal SSE para notificaciones en tiempo real (ver lib/sse.ts y
 * docs/sse-notificaciones.md).
 *
 * La bandeja sale del rol de la sesión firmada, nunca de un query del cliente:
 * controlador -> deposit, billing -> billing, vendedor -> vendor, admin -> all.
 * Cada cliente mantiene la conexión abierta y solo recibe eventos de su
 * bandeja; en vendor el bus además filtra por `targetUserId`.
 */
export const GET = withRouteLogging(async (request: Request) => {
  const auth = requireSession(request);
  if ('response' in auth) return auth.response;

  // Con Cache Components activo, connection() excluye al handler del prerender:
  // el stream tiene que nacer de un request real, no de una respuesta estática.
  await connection();

  const stream = createEventStream({
    userId: auth.session.userId,
    username: auth.session.username,
    inbox: notificationInboxForRole(auth.session.role),
    ip: resolveClientIp(request),
    lastEventId: request.headers.get('last-event-id'),
  });

  return new Response(stream, { headers: SSE_HEADERS });
});
