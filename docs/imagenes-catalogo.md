# Imágenes del catálogo con `next/image`

El listado de productos de **Nuevo pedido** (`app/orders/new`) muestra un
thumbnail por fila (40×40 en escritorio, 48×48 en móvil). Antes se renderizaba
con `<img>` y el navegador descargaba la imagen original completa; ahora usa
`components/ProductThumbnail.tsx` con `next/image`.

## Qué cambió

- `next/image` con `width`/`height` fijos (40 o 48 px) y `loading="lazy"`.
- Sin `sizes`: Next genera un `srcset` compacto 1x/2x y redondea los anchos a
  `imageSizes` (40 px → 48w, 80 px → 96w). El HTML no repite la lista completa
  de `deviceSizes` en cada fila.
- `next.config.ts` declara `images.remotePatterns` con los hosts permitidos y
  `images.qualities: [75]`.
- Los hosts no listados se siguen mostrando con `unoptimized` (la URL original
  se usa tal cual), así que una URL de proveedor nueva no rompe el catálogo,
  pero tampoco pasa por `/_next/image`.
- La allowlist vive en `lib/image-sources.ts` y la comparten el componente y
  `next.config.ts`. Para habilitar un proveedor nuevo, agregar su hostname ahí
  y reiniciar el servidor.

## Medición

Metodología: tres JPEG cuadrados representativos (600, 800 y 1200 px) servidos
desde `public/`, pedidos al optimizador real de Next (`/_next/image?w=…&q=75`)
con `Accept: image/webp`. Se midieron los dos anchos que usa el listado:
**48w** (1x) y **96w** (2x). La base local no tenía datos de producción, así
que las fotos son una muestra; los anchos y el componente sí son los reales.

| Original | 48w (1x) | 96w (2x) | Ahorro en 2x |
| ---: | ---: | ---: | ---: |
| 90.042 B | 720 B | 1.726 B | 98,1 % |
| 95.203 B | 416 B | 1.186 B | 98,8 % |
| 46.432 B | 716 B | 1.894 B | 95,9 % |
| **77.226 B (prom.)** | **617 B** | **1.602 B** | **97,9 %** |

El listado pide **50 productos por página**:

| Escenario | Peso de imágenes |
| --- | ---: |
| 50 originales (comportamiento anterior) | ~3,86 MB |
| 50 optimizadas a 1x | ~30,9 KB |
| 50 optimizadas a 2x | ~80,1 KB |

Además, con `loading="lazy"` las filas fuera del viewport no se piden hasta
que el usuario se acerca. Una estimación con 8 filas visibles a 2x baja el
payload inicial de imágenes de ~618 KB a ~12,8 KB.

La primera request de cada variante es `MISS`; las siguientes se sirven desde
la caché del optimizador (`x-nextjs-cache: HIT`, `Cache-Control: public,
max-age=14400, must-revalidate`). La medición de bytes es por imagen única, no
por cada visita.

## Verificación

- `npm run lint`
- `npm run typecheck`
- `npm test` (incluye `scripts/test-image-sources.ts`)
- `npm run build`
- Render real de `ProductThumbnail`: `loading="lazy"`, `width`/`height`,
  `srcset` de 48w/96w y fallback sin `srcset` para hosts no permitidos.
- Optimizador: host permitido (`images.unsplash.com`) responde `200
  image/webp`; host no permitido responde `400 "url" parameter is not allowed`.
