# Imágenes del catálogo con `next/image`

El listado de productos de **Nuevo pedido** (`app/orders/new`) muestra un
thumbnail por fila (40×40 en escritorio, 48×48 en móvil). Antes se renderizaba
con `<img>` y el navegador descargaba la imagen original completa; ahora usa
`components/ProductThumbnail.tsx` con `next/image`.

## Qué cambió

- `next/image` con `width`/`height` fijos (40, 44 o 48 px), `loading="lazy"`,
  `decoding="async"`, `quality={75}` y
  `sizes="(max-width: 640px) {size}px, {size}px"`. El `sizes` acota el `srcset`
  al tamaño real de la miniatura: el navegador nunca pide una variante de
  viewport completa.
- `next.config.ts` declara `images.remotePatterns` con los hosts permitidos y
  `images.qualities: [75]`.
- La allowlist vive en `lib/image-sources.ts` y la comparten el componente y
  `next.config.ts`. Para habilitar un proveedor nuevo, agregar su hostname ahí
  y reiniciar el servidor.
- Los hosts que no están en la allowlist **no descargan la imagen original**.
  `ProductThumbnail` muestra el placeholder de imagen con un badge discreto
  “Imagen no optimizada” (icono + texto para lectores de pantalla). Se eligió
  esta opción en lugar de un proxy propio: evita abrir un endpoint de fetch
  arbitrario (SSRF) y no necesita una caché adicional.

## Auditoría de hosts reales

`scripts/audit-image-hosts.ts` lee los `Product.imageUrl` distintos de la base,
extrae el hostname y marca los que no pasan por la allowlist. Sólo imprime
protocolo + hostname, nunca la URL completa, para no filtrar tokens de firma.

```bash
# Usa MONGODB_URI de .env.local
npm run audit:image-hosts

# Contra producción (definí la URI en el entorno, no en el repo)
MONGODB_URI="mongodb+srv://usuario:clave@cluster.mongodb.net/sgi" \
  npm run audit:image-hosts

# Salida para pegar en un ticket/PR
npm run audit:image-hosts -- --json
```

El script termina con código 1 si encuentra hosts fuera de la allowlist. La
auditoría local no pudo ejecutarse contra la base de producción porque este
entorno no tiene acceso a esa URI; el comando queda documentado para correrlo
en el servidor o en la máquina con `.env.local` real. La allowlist incluye los
hosts de los proveedores ya usados por el catálogo (MercadoLibre, Cloudinary,
Supabase, AWS/CloudFront, Shopify) y los CDN de Tiendanube y VTEX habituales en
distribuidoras argentinas. El host reservado `inventario.example.com` se
mantiene sólo como marcador de la demo; no aporta imágenes reales.

## Validación de `imageUrl`

El mismo esquema (`imageUrlSchema` en `lib/validations.ts`) se aplica al alta y
edición de productos (`productSchema`) y a la importación de catálogo
(`lib/catalog-import.ts`). Acepta:

- vacío (producto sin imagen);
- rutas locales que empiezan con `/` (`/uploads/foto.jpg`);
- URLs absolutas `https:`.

Rechaza `javascript:`, `data:`, `blob:`, `http:`, URLs protocol-relative
(`//host/...`), credenciales embebidas (`https://user:pass@host/...`),
backslashes/caracteres de control y textos de más de 2048 caracteres. En la
importación, una URL inválida descarta **sólo esa fila** y se informa como error
de fila (`field: "imagen"`); el resto del archivo se sigue procesando.

## Medición

Metodología: tres JPEG cuadrados representativos (600, 800 y 1200 px) servidos
desde `public/`, pedidos al optimizador real de Next (`/_next/image?w=…&q=75`)
con `Accept: image/webp`. Se midieron los dos anchos que usa el listado:
**48w** (1x) y **96w** (2x).

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
| Host desconocido (ahora) | 0 B (placeholder) |

Además, con `loading="lazy"` las filas fuera del viewport no se piden hasta
que el usuario se acerca. La primera request de cada variante es `MISS`; las
siguientes se sirven desde la caché del optimizador (`x-nextjs-cache: HIT`,
`Cache-Control: public, max-age=14400, must-revalidate`).

## Presupuesto de imágenes en CI

`scripts/lighthouse-ci.mjs` suma el `transferSize` de todas las requests con
`resourceType === 'Image'` y el audit `total-byte-weight` de cada corrida
mobile. La mediana queda en `.lighthouseci/summary.json` y se compara con
`performance-budgets.json`:

| Ruta | `imageBytes` | `totalByteWeightBytes` |
| --- | ---: | ---: |
| `/orders/new` | 120.000 B | 700.000 B |
| `/deposit/orders/[id]` | 120.000 B | 700.000 B |

El resumen de Lighthouse imprime “Imágenes” y “Peso total” por ruta y falla si
se supera cualquiera de los umbrales.

## Verificación

- `npm run lint`
- `npm run typecheck`
- `npm test` (incluye `scripts/test-image-sources.ts`,
  `scripts/test-product-thumbnail.tsx` y la validación de importación)
- `npm run build`
- `npm run perf:lighthouse`
- Render real: `loading="lazy"`, `decoding="async"`, `sizes` de 48px, `q=75`
  en el `srcset`; host desconocido sin `<img>` y con badge de imagen no
  optimizada.
