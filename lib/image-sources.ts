/**
 * Fuentes remotas que pueden pasar por el optimizador de `next/image`.
 *
 * El catálogo acepta URLs de imagen provistas por proveedores (importación de
 * Excel o alta manual), así que no hay un único dominio conocido. Mantenemos
 * una lista explícita para no exponer el optimizador a cualquier host y, para
 * las URLs que no están listadas, `ProductThumbnail` usa `unoptimized`: la
 * imagen se sigue mostrando, pero el servidor no la descarga ni la reescala.
 *
 * Al sumar un proveedor nuevo, agregar su hostname acá (y reiniciar el server
 * para que `next.config.ts` tome el cambio).
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
  '*.inventario.example.com',
  'inventario.example.com',
  'example.com',
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

/**
 * Indica si una URL puede optimizarse con la configuración de next.config.ts.
 *
 * Las rutas locales (`/uploads/...`) siempre se optimizan. Las URLs `data:` y
 * `blob:` no pasan por el optimizador y deben renderizarse con `unoptimized`.
 */
export function isOptimizableImageUrl(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('/')) return true;
  if (src.startsWith('data:') || src.startsWith('blob:')) return false;

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;

  const hostname = url.hostname.toLowerCase();
  return OPTIMIZABLE_IMAGE_HOSTS.some((pattern) => hostMatchesPattern(hostname, pattern));
}
