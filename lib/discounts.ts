/**
 * Resolución de descuentos del cliente para una línea de pedido.
 *
 * Regla comercial (alta y picking): el descuento por marca pisa al descuento
 * general del cliente. Ante marcas repetidas en la configuración gana la
 * primera coincidencia.
 *
 * `buildClientDiscountResolver` precomputa el mapa brandId -> % una sola vez
 * para que el alta/picking no recorra `brandDiscounts` por cada ítem.
 */

export interface ClientDiscountConfigLike {
  generalDiscount?: number | string | null;
  brandDiscounts?: Array<{
    brandId?: unknown;
    discountPercentage?: number | string | null;
  }> | null;
}

export interface ClientDiscountResolver {
  /** Descuento general normalizado (0 si no es numérico). */
  generalPercentage: number;
  /** Normaliza un porcentaje ingresado como número o string. */
  normalize(value: unknown): number;
  /** Porcentaje configurado para la marca, o undefined si no tiene uno. */
  brandPercentage(brandId: unknown): number | undefined;
  /** Porcentaje aplicable: marca si existe, si no el general. */
  resolveForBrand(brandId: unknown): number;
}

/** Normaliza un brandId que puede venir como ObjectId, string o doc poblado ({ _id }). */
export function brandIdToString(brandId: unknown): string | undefined {
  if (brandId === null || brandId === undefined) return undefined;
  const value = brandId as { _id?: unknown };
  if (typeof value === 'object' && '_id' in value) return String(value._id);
  return String(value);
}

/** Normaliza un porcentaje de descuento; valores no numéricos caen a 0. */
export function percentageToNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Resuelve el porcentaje de una marca contra un mapa ya construido (por
 * ejemplo, los descuentos editables del alta). Si la marca no tiene valor,
 * rige el general; un `NaN` se considera ausente.
 */
export function resolveBrandDiscountPercentage(
  brandId: unknown,
  brandDiscounts: Readonly<Record<string, number | undefined>>,
  generalPercentage: number,
): number {
  const key = brandIdToString(brandId);
  const brandPercentage = key ? brandDiscounts[key] : undefined;
  return brandPercentage !== undefined && !Number.isNaN(brandPercentage)
    ? brandPercentage
    : generalPercentage || 0;
}

/**
 * Precomputa la configuración de descuentos para resolver muchas líneas sin
 * volver a buscar en `brandDiscounts` por ítem.
 */
export function buildClientDiscountResolver(
  client: ClientDiscountConfigLike | null | undefined,
): ClientDiscountResolver {
  const generalPercentage = percentageToNumber(client?.generalDiscount);
  const brandDiscountByBrandId = new Map<string, number>();

  for (const brandDiscount of client?.brandDiscounts ?? []) {
    const key = brandIdToString(brandDiscount.brandId);
    if (key && !brandDiscountByBrandId.has(key)) {
      brandDiscountByBrandId.set(key, percentageToNumber(brandDiscount.discountPercentage));
    }
  }

  return {
    generalPercentage,
    normalize: percentageToNumber,
    brandPercentage(brandId: unknown): number | undefined {
      const key = brandIdToString(brandId);
      return key ? brandDiscountByBrandId.get(key) : undefined;
    },
    resolveForBrand(brandId: unknown): number {
      const key = brandIdToString(brandId);
      const brandPercentage = key ? brandDiscountByBrandId.get(key) : undefined;
      return brandPercentage ?? generalPercentage;
    },
  };
}

/**
 * Porcentaje de descuento vigente del cliente para un producto de esa marca:
 * descuento por marca si existe, si no el general. Valores no numéricos caen a 0.
 */
export function resolveClientDiscountPercentage(
  client: ClientDiscountConfigLike | null | undefined,
  productBrandId: unknown,
): number {
  return buildClientDiscountResolver(client).resolveForBrand(productBrandId);
}
