import Image from 'next/image';
import { Image as ImageIcon } from 'lucide-react';

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
 * `width`/`height` definen el tamaño real del thumbnail. Sin `sizes`, Next
 * genera un srcset compacto 1x/2x y redondea los anchos a `imageSizes`
 * (40 px → 48w, 80 px → 96w), así que no se piden variantes de viewport
 * completa. `loading="lazy"` evita pedir las imágenes de las filas que
 * todavía no se ven.
 *
 * Si la URL no está en la allowlist de `lib/image-sources.ts`, se renderiza
 * con `unoptimized` para que siga funcionando sin exponer el optimizador.
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

  if (!normalizedSrc) {
    return (
      <div
        aria-hidden="true"
        className={`${dimensions} flex items-center justify-center rounded-md border text-subtle ${border} bg-surface-muted ${className}`}
      >
        <ImageIcon className="w-5 h-5" />
      </div>
    );
  }

  return (
    <Image
      src={normalizedSrc}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      unoptimized={!isOptimizableImageUrl(normalizedSrc)}
      className={`${dimensions} rounded-md border object-cover ${border} ${className}`}
    />
  );
}
