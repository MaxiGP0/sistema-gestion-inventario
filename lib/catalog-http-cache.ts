/**
 * Cabeceras HTTP de los GET de catálogo.
 *
 * Son respuestas autenticadas (`private`) y con vida corta en el navegador:
 * clientes 30 s porque sus descuentos inciden en el precio del pedido;
 * productos/marcas 60 s porque cambian con menos frecuencia. La ventana de
 * `stale-while-revalidate` permite responder al instante mientras el navegador
 * refresca en segundo plano.
 *
 * No se aplican a pedidos, notificaciones ni SSE.
 */

export type CatalogHttpResource = 'products' | 'brands' | 'clients';

export const CATALOG_CACHE_CONTROL: Record<CatalogHttpResource, string> = {
  products: 'private, max-age=60, stale-while-revalidate=300',
  brands: 'private, max-age=60, stale-while-revalidate=300',
  clients: 'private, max-age=30, stale-while-revalidate=120',
};

export function catalogCacheHeaders(
  resource: CatalogHttpResource,
): Record<'Cache-Control', string> {
  return { 'Cache-Control': CATALOG_CACHE_CONTROL[resource] };
}
