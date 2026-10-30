import { NextResponse } from 'next/server';
import { requireCurrentRole } from '@/lib/auth';
import { handleRouteError, parseJsonBody } from '@/lib/api-errors';
import { revalidateCatalog } from '@/lib/catalog-cache';
import { adjustProductPricesByBrand } from '@/lib/product-price-service';
import { formatAdjustmentPercentage } from '@/lib/product-pricing';
import { bulkPriceAdjustmentSchema } from '@/lib/validations';
import type { BulkPriceAdjustmentResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';

/**
 * Ajuste porcentual masivo de precios (`price` y `priceWithIva`).
 *
 * Sólo administradores. El body indica la marca (opcional; sin marca alcanza a
 * todo el catálogo activo) y el porcentaje, que puede ser positivo o negativo.
 * Los precios se recalculan y redondean a 2 decimales en el servidor.
 */
export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    const parsedBody = await parseJsonBody(request, bulkPriceAdjustmentSchema);
    if (!parsedBody.success) return parsedBody.response;

    const { brandId, percentage } = parsedBody.data;
    const result = await adjustProductPricesByBrand({ brandId, percentage });

    // El catálogo (productos y precios) se sirve desde `use cache`: hay que
    // invalidarlo para que el próximo render vea los importes nuevos.
    if (result.modified > 0) revalidateCatalog('products');

    const alcance = brandId ? 'de la marca seleccionada' : 'de todo el catálogo';
    const response: BulkPriceAdjustmentResponse = {
      success: true,
      message:
        result.modified > 0
          ? `${result.modified} producto(s) ${alcance} actualizados con ${formatAdjustmentPercentage(percentage)}`
          : 'No hay productos activos para ajustar con ese filtro',
      matched: result.matched,
      updated: result.modified,
      brandId: brandId ?? null,
      percentage,
    };

    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al ajustar precios masivamente:' });
  }
});
