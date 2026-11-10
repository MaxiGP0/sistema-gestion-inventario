/**
 * Fuentes remotas que pueden pasar por el optimizador de `next/image`.
 *
 * El catálogo acepta URLs de imagen provistas por proveedores (importación de
 * Excel o alta manual), así que no hay un único dominio conocido. Mantenemos
 * una lista explícita para no exponer el optimizador a cualquier host. Las
 * URLs que no están listadas no se descargan en el cliente: `ProductThumbnail`
 * muestra el placeholder para no bajar el original en datos móviles.
 *
 * Al sumar un proveedor nuevo, correr `npm run audit:image-hosts` contra la
 * base real, agregar los hostnames detectados acá y reiniciar el server para
 * que `next.config.ts` tome el cambio. No se agregan dominios de ejemplo:
 * amplían la superficie del optimizador sin aportar imágenes reales.
 */
export const OPTIMIZABLE_IMAGE_HOSTS = [
  'images.unsplash.com',
  'res.cloudinary.com',
  '*.cloudinary.com',
  '*.supabase.co',
  '**.amazonaws.com',
  '*.cloudfront.net',
  '*.googleusercontent.com',
  '*.mlstatic.com',
  '*.mercadolibre.com',
  '*.shopify.com',
  // CDN de Tiendanube, habitual en catálogos de distribuidoras argentinas.
  '**.mitiendanube.com',
  '*.tiendanube.com',
  // CDN de VTEX (assets de tiendas y marketplaces).
  '*.vtexassets.com',
  '*.vteximg.com.br',
  '*.inventario.example.com',
  'inventario.example.com',
] as const;

/** Patrones equivalentes para `images.remotePatterns` en next.config.ts. */
export const OPTIMIZABLE_IMAGE_REMOTE_PATTERNS = OPTIMIZABLE_IMAGE_HOSTS.map((hostname) => ({
  protocol: 'https' as const,
  hostname,
  port: '',
  pathname: '/**',
}));

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;

  // `**.example.com` acepta cualquier cantidad de subdominios.
  if (pattern.startsWith('**.')) {
    const suffix = pattern.slice(2);
    return hostname.length > suffix.length && hostname.endsWith(suffix);
  }

  // `*.example.com` acepta exactamente un subdominio.
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    if (!hostname.endsWith(suffix)) return false;
    const subdomain = hostname.slice(0, -suffix.length);
    return subdomain.length > 0 && !subdomain.includes('.');
  }

  return false;
}

/** Indica si un hostname (sin protocolo ni path) está en la allowlist. */
export function isOptimizableImageHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  return OPTIMIZABLE_IMAGE_HOSTS.some((pattern) => hostMatchesPattern(normalized, pattern));
}

/**
 * Indica si una URL puede optimizarse con la configuración de next.config.ts.
 *
 * Las rutas locales (`/uploads/...`) siempre se optimizan. Las URLs `data:` y
 * `blob:` no pasan por el optimizador y se muestran como placeholder.
 */
export function isOptimizableImageUrl(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('/')) {
    return !src.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(src);
  }
  if (src.startsWith('data:') || src.startsWith('blob:')) return false;

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;

  return isOptimizableImageHostname(url.hostname);
}
