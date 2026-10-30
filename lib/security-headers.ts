/**
 * Cabeceras de seguridad para todas las respuestas de la aplicación.
 *
 * La CSP se entrega en **Report-Only**: el navegador informa las violaciones
 * pero no bloquea nada todavía. Se deja `'unsafe-inline'` en `script-src`
 * porque Next.js inyecta scripts inline (bootstrap/RSC) y el layout aplica el
 * tema antes del primer paint con otro script inline.
 *
 * ¿Por qué no nonce? La guía de Next.js 16 (`dist/docs/.../content-security-policy.md`)
 * exige renderizado dinámico para que Next inyecte el nonce en todos sus
 * scripts. Este proyecto usa `cacheComponents` (PPR), que es incompatible con
 * ese modo. La alternativa experimental es SRI (`experimental.sri`), que sólo
 * cubre los bundles externos, no los inline. Por eso arrancamos con una CSP
 * Report-Only estática y, cuando se decida pasar a enforcing, el camino es:
 * habilitar SRI y mover el script de tema a un archivo externo (o desactivar
 * PPR y usar nonce).
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * HSTS se emite sólo en producción. No se agrega `preload` ni se incluyen
 * subdominios por defecto: eso debe confirmarse con la infraestructura real.
 */
export const HSTS_VALUE = 'max-age=31536000';

export const PERMISSIONS_POLICY_VALUE =
  'camera=(), microphone=(), geolocation=(), browsing-topics=()';

/** Construye la lista de headers; `isProduction` permite testear ambos modos. */
export function buildSecurityHeaders(
  isProduction = process.env.NODE_ENV === 'production',
): SecurityHeader[] {
  const isDevelopment = !isProduction;

  const contentSecurityPolicy = [
    "default-src 'self'",
    // Sólo en desarrollo React usa eval para reconstruir stack traces.
    `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Las imágenes remotas no optimizadas se cargan directo desde su host.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // El HMR de `next dev` usa WebSocket; en producción alcanza con 'self'.
    `connect-src 'self'${isDevelopment ? ' ws: wss:' : ''}`,
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const headers: SecurityHeader[] = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY_VALUE },
    { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy },
  ];

  if (isProduction) {
    headers.push({ key: 'Strict-Transport-Security', value: HSTS_VALUE });
  }

  return headers;
}
