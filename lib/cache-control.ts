/**
 * Cabeceras de caché compartidas por páginas y GET de lectura.
 *
 * `no-store` impide que el navegador use la página al volver con "atrás"
 * (bfcache). Para datos autenticados alcanza con `private` + `no-cache`:
 * nunca se comparten entre usuarios, se guardan como máximo en la caché
 * privada del navegador y cada reutilización debe revalidarse.
 *
 * No usar en auth/session, SSE ni mutaciones: esos flujos siguen con
 * `no-store`/`no-cache` según corresponda.
 */
export const PRIVATE_REVALIDATE_CACHE_CONTROL = 'private, no-cache, max-age=0, must-revalidate';

export const PRIVATE_REVALIDATE_HEADERS: Record<'Cache-Control', string> = {
  'Cache-Control': PRIVATE_REVALIDATE_CACHE_CONTROL,
};
