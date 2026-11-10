import Image from 'next/image';
import { AlertTriangle, Image as ImageIcon } from 'lucide-react';

import { isOptimizableImageUrl } from '@/lib/image-sources';

export interface ProductThumbnailProps {
  src?: string;
  alt: string;
  /** Tamaño de render en píxeles (coincide con `width`/`height` intrínsecos). */
  size: 40 | 44 | 48;
  className?: string;
}

/**
 * Acepta URLs absolutas y rutas locales. Las rutas relativas sin `/` inicial
 * se resuelven desde la raíz para que `next/image` no falle al parsearlas.
 */
function normalizeImageSrc(src?: string): string | undefined {
  const value = src?.trim();
  if (!value) return undefined;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `/${value}`;
}

/**
 * Thumbnail del catálogo con `next/image`.
 *
 * `width`/`height` definen el tamaño real del thumbnail. `sizes` le dice al
 * navegador que nunca necesita una variante más ancha que el propio thumbnail,
 * `quality={75}` evita pedir una imagen de más peso y `loading="lazy"` deja
 * fuera las filas que todavía no se ven.
 *
 * Sólo los hosts de `lib/image-sources.ts` pasan por `/_next/image`. Para el
 * resto se muestra el placeholder con un badge “Imagen no optimizada” en vez
 * de descargar la imagen original: en mobile esa descarga es justamente el
 * costo que este componente evita.
 */
export default function ProductThumbnail({
  src,
  alt,
  size,
  className = '',
}: ProductThumbnailProps) {
  const normalizedSrc = normalizeImageSrc(src);
  const dimensions = size === 40 ? 'w-10 h-10' : size === 44 ? 'w-11 h-11' : 'w-12 h-12';
  const border = 'border-border';

  if (!normalizedSrc || !isOptimizableImageUrl(normalizedSrc)) {
    const hasUnoptimizedImage = Boolean(normalizedSrc);

    return (
      <div
        aria-label={hasUnoptimizedImage ? `${alt}. Imagen no optimizada` : alt}
        aria-hidden={hasUnoptimizedImage ? undefined : true}
        role={hasUnoptimizedImage ? 'img' : undefined}
        className={`${dimensions} relative flex items-center justify-center rounded-md border text-subtle ${border} bg-surface-muted ${className}`}
      >
        <ImageIcon className="w-5 h-5" aria-hidden="true" />
        {hasUnoptimizedImage ? (
          <span
            title="Imagen no optimizada"
            className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-status-draft-border bg-status-draft-soft text-status-draft"
          >
            <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
            <span className="sr-only">Imagen no optimizada</span>
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Image
      src={normalizedSrc}
      alt={alt}
      width={size}
      height={size}
      sizes={`(max-width: 640px) ${size}px, ${size}px`}
      quality={75}
      decoding="async"
      loading="lazy"
      className={`${dimensions} rounded-md border object-cover ${border} ${className}`}
    />
  );
}
