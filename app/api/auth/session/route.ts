import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { requireCurrentSession } from '@/lib/auth';
import { handleRouteError } from '@/lib/api-errors';
import type { SessionResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * Devuelve el usuario de la sesión actual (fuente de verdad del contexto de
 * usuario en el cliente: reemplaza al viejo `sgi_user` de localStorage).
 *
 * Usa `requireCurrentSession`: si el usuario fue desactivado, eliminado o su
 * `sessionVersion` cambió, responde 401 y borra la cookie aunque la firma siga
 * vigente.
 */
export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentSession(request);
    if ('response' in auth) return auth.response;

    const response: SessionResponse = {
      success: true,
      user: {
        id: auth.session.userId,
        username: auth.session.username,
        role: auth.session.role,
        notificationsEnabled: auth.currentUser?.notificationsEnabled !== false,
      },
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    // Los errores internos de Next (p. ej. el bail-out de prerender al leer la
    // cookie durante el build de Cache Components) nunca deben convertirse en
    // un 500 nuestro: se reenvían para que Next los maneje.
    unstable_rethrow(error);

    return handleRouteError(error, { context: 'Error al obtener la sesión:' });
  }
});
