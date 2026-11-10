/**
 * Resolución de la IP del cliente y confianza en cabeceras de proxy.
 *
 * Por defecto `TRUST_PROXY_HEADERS=false`: cualquier cliente puede inventar
 * `x-forwarded-for`, así que leerlas sin un proxy confiable permitiría evadir
 * el rate limit por IP. En ese caso se usa una IP desconocida y el límite por
 * usuario (siempre derivado de la sesión) hace el trabajo.
 *
 * Activar la variable sólo cuando la app esté detrás de un proxy/balanceador
 * propio que reescriba esas cabeceras.
 */

export const UNKNOWN_CLIENT_IP = 'desconocida';

/** Lee la variable en cada llamada para que los tests puedan alternarla. */
export function trustProxyHeadersEnabled(): boolean {
  const raw = process.env.TRUST_PROXY_HEADERS?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/**
 * Primer salto de `x-forwarded-for` o `x-real-ip` cuando las cabeceras son
 * confiables; en caso contrario devuelve `unknownIp`.
 */
export function resolveClientIp(request: Request, unknownIp: string = UNKNOWN_CLIENT_IP): string {
  if (!trustProxyHeadersEnabled()) return unknownIp;

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstHop = forwardedFor.split(',')[0]?.trim();
    if (firstHop) return firstHop;
  }

  return request.headers.get('x-real-ip')?.trim() || unknownIp;
}
