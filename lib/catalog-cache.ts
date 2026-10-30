import { revalidateTag } from 'next/cache';

/**
 * Tags de la caché de datos del catálogo.
 *
 * Las consultas de `lib/catalog.ts` usan la directiva `'use cache'` y declaran
 * estos tags con `cacheTag`; los route handlers que mutan el catálogo los
 * invalidan para que el `router.refresh()` posterior a un alta/edición/baja vea
 * datos frescos sin esperar el `revalidate` periódico.
 */
export const CATALOG_TAGS = {
  brands: 'catalog:brands',
  products: 'catalog:products',
  clients: 'catalog:clients',
} as const;

/** Revalidación periódica de respaldo para el catálogo (en segundos). */
export const CATALOG_REVALIDATE_SECONDS = 60;

export type CatalogCacheKey = keyof typeof CATALOG_TAGS;

export function revalidateCatalog(...keys: CatalogCacheKey[]): void {
  for (const key of keys) {
    try {
      // `expire: 0` evita servir datos viejos después de una mutación: el
      // próximo request bloquea y recalcula en vez de hacer stale-while-revalidate.
      revalidateTag(CATALOG_TAGS[key], { expire: 0 });
    } catch {
      // Los tests unitarios invocan los handlers sin el store de Next; ahí
      // `revalidateTag` no tiene contexto y no hay caché que invalidar.
    }
  }
}
