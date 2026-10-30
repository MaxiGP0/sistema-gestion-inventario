/**
 * Snapshots de las líneas del pedido.
 *
 * Cada línea guarda código, nombre y marca del producto al momento del alta
 * para que el detalle siga siendo legible si el producto se elimina (el
 * populate de `items.productId` devuelve null). Los pedidos históricos sin
 * snapshot usan el fallback de la UI: `productName ?? productId?.name`.
 */

export interface ProductSnapshotSource {
  code?: string;
  name?: string;
  /** ObjectId de marca o documento poblado ({ name }). */
  brandId?: unknown;
}

export interface OrderItemSnapshot {
  productCode?: string;
  productName?: string;
  brandName?: string;
}

/** El brandId de Product puede venir como ObjectId (sin nombre) o poblado. */
export function brandNameOf(brandId: unknown): string | undefined {
  if (!brandId || typeof brandId !== 'object') return undefined;

  const name = (brandId as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name : undefined;
}

/** Snapshot persistible de un producto del catálogo. */
export function productSnapshotOf(
  product: ProductSnapshotSource | null | undefined,
): OrderItemSnapshot {
  return {
    productCode: product?.code,
    productName: product?.name,
    brandName: brandNameOf(product?.brandId),
  };
}
