/**
 * Ajuste masivo de precios por marca.
 *
 * Se resuelve en dos pasos: primero se leen los productos activos alcanzados
 * (para poder informar cuántos son) y luego se persisten los nuevos importes
 * con un único `bulkWrite`. Los precios se recalculan con `lib/product-pricing`
 * para que la UI y la base usen exactamente el mismo redondeo.
 */
import type { Types } from 'mongoose';
import dbConnect from './mongodb';
import { Product } from '@/models/Product';
import { calculateAdjustedPrices } from './product-pricing';

export interface BulkPriceAdjustmentInput {
  /** Marca a ajustar; si se omite, alcanza a todo el catálogo activo. */
  brandId?: string;
  percentage: number;
}

export interface BulkPriceAdjustmentResult {
  /** Productos activos alcanzados por el filtro. */
  matched: number;
  /** Productos cuyo precio cambió efectivamente. */
  modified: number;
}

interface LeanPricedProduct {
  _id: Types.ObjectId;
  price?: number;
  priceWithIva?: number;
}

/**
 * Aplica `percentage` a `price` y `priceWithIva` de cada producto activo de la
 * marca indicada (o de todas si no se indica marca). Devuelve los conteos para
 * que la API pueda responder cuántos productos se actualizaron.
 */
export async function adjustProductPricesByBrand({
  brandId,
  percentage,
}: BulkPriceAdjustmentInput): Promise<BulkPriceAdjustmentResult> {
  await dbConnect();

  const query: Record<string, unknown> = { active: { $ne: false } };
  if (brandId) query.brandId = brandId;

  const products = (await Product.find(query)
    .select('_id price priceWithIva')
    .lean()) as unknown as LeanPricedProduct[];

  if (products.length === 0) {
    return { matched: 0, modified: 0 };
  }

  const operations = products.map((product) => ({
    updateOne: {
      filter: { _id: product._id },
      update: {
        $set: calculateAdjustedPrices(
          {
            price: Number(product.price) || 0,
            priceWithIva: product.priceWithIva,
          },
          percentage,
        ),
      },
    },
  }));

  const result = await Product.bulkWrite(operations, { ordered: false });

  return {
    matched: products.length,
    modified: typeof result?.modifiedCount === 'number' ? result.modifiedCount : products.length,
  };
}
