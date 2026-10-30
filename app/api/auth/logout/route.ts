import { NextResponse } from 'next/server';
import { clearSessionCookies } from '@/lib/session';
import type { LogoutResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * Cierra la sesión del servidor: la cookie firmada no se puede invalidar por
 * sí sola, así que se responde borrándola del navegador (httpOnly => solo el
 * servidor puede hacerlo).
 */
export const POST = withRouteLogging(async () => {
  const body: LogoutResponse = {
    success: true,
    message: 'Sesión cerrada correctamente',
  };
  const response = NextResponse.json(body);

  clearSessionCookies(response);

  return response;
});
