/**
 * Lógica pura del alta de pedidos: tipos del catálogo, normalización de
 * descuentos, agrupación por marca y cálculo de totales.
 *
 * Vive fuera de la página para poder probarse sin navegador ni base de datos.
 * El orden de precedencia de descuentos es el mismo que usa la API:
 * producto (manual) > marca > general del cliente. La resolución por marca se
 * delega en `lib/discounts.ts` para no duplicar la regla comercial.
 */

import {
  brandIdToString,
  buildClientDiscountResolver,
  resolveBrandDiscountPercentage,
} from './discounts';
import type { BrandDTO, ClientDTO, ProductDTO } from './types';

/**
 * Cliente del alta: los campos obligatorios de la ficha más los que puede
 * traer un borrador restaurado (o un fixture de test) sin completar.
 */
export interface OrderCatalogClient extends Pick<ClientDTO, '_id' | 'code' | 'name'> {
  address?: string;
  localidad?: string;
  province?: string;
  generalDiscount?: number;
  brandDiscounts?: {
    brandId: string | { _id: string };
    discountPercentage: number;
  }[];
}

export type OrderCatalogBrand = BrandDTO;

/**
 * Producto del catálogo: el `brandId` puede venir poblado (API) o plano
 * (borradores/fixtures), por eso se amplía el DTO compartido.
 */
export interface OrderCatalogProduct extends Pick<
  ProductDTO,
  '_id' | 'code' | 'name' | 'price' | 'imageUrl'
> {
  brandId: string | { _id: string; name?: string };
  priceWithIva?: number;
}

export type DiscountMap = Record<string, number>;
export type QuantityMap = Record<string, number>;
export type CatalogBrandRef = string | { _id: string; name?: string } | null | undefined;

/**
 * Valor del filtro rápido del catálogo que muestra sólo los productos con
 * cantidad > 0. No es un id de marca: por eso se compara explícitamente antes
 * de enviarlo como `brandId` a la API.
 */
export const SELECTED_PRODUCTS_FILTER = 'SELECTED';

export interface ClientDiscounts {
  general: number;
  brandDiscounts: DiscountMap;
}

export interface BrandProductGroup {
  brandId: string;
  brandName: string;
  products: OrderCatalogProduct[];
}

export interface DiscountBySource {
  general: number;
  brand: number;
  item: number;
}

export interface OrderTotals {
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  discountBySource: DiscountBySource;
}

export interface OrderItemInput {
  productId: string;
  requestedQuantity: number;
  customDiscount: number;
}

export interface BuildOrderItemsResult {
  items: OrderItemInput[];
  missingProductIds: string[];
}

/** Normaliza el `brandId` poblado (objeto) o plano (string/ObjectId serializado). */
export function getBrandId(brandId: CatalogBrandRef): string {
  if (typeof brandId === 'object' && brandId !== null) return String(brandId._id || '');
  return String(brandId || '');
}

/** Redondea y limita un porcentaje al rango válido [0, 100]. */
export function clampDiscount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Interpreta el valor de un input de descuento.
 * - Vacío -> `undefined`: el campo se elimina y hereda el descuento de la marca/general.
 * - Texto inválido -> `0`.
 * - Fuera de rango -> se limita a [0, 100].
 */
export function parseDiscountInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  return clampDiscount(Number.parseFloat(value));
}

/** Igual que `parseDiscountInput` pero un campo vacío equivale a 0 (descuento general). */
export function parseGeneralDiscount(value: string): number {
  return parseDiscountInput(value) ?? 0;
}

/**
 * Texto de presentación del descuento general. Un 0 efectivo se muestra vacío
 * para que el input use el placeholder "0" (patrón "valor fantasma"), igual
 * que los descuentos por marca.
 */
export function formatGeneralDiscountInput(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return String(value);
}

/** Cantidad de un input: entero no negativo; texto inválido cuenta como 0. */
export function parseQuantityInput(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/** Aplica +/- evitando bajar de 0 (botones de la vista móvil). */
export function applyQuantityDelta(current: number | undefined, delta: number): number {
  const base = Number.isFinite(current) ? Number(current) : 0;
  return Math.max(0, base + delta);
}

/**
 * Descuentos configurados en la ficha del cliente, listos para el formulario.
 * Usa el resolver compartido para que ante marcas repetidas gane la primera
 * coincidencia, igual que en el alta del servidor y en el picking.
 */
export function getClientDiscounts(client: OrderCatalogClient | null | undefined): ClientDiscounts {
  const resolver = buildClientDiscountResolver(client);
  const brandDiscounts: DiscountMap = {};

  for (const discount of client?.brandDiscounts ?? []) {
    const brandId = brandIdToString(discount.brandId);
    if (!brandId) continue;
    const percentage = resolver.brandPercentage(brandId);
    if (percentage !== undefined) brandDiscounts[brandId] = clampDiscount(percentage);
  }

  return {
    general: clampDiscount(resolver.generalPercentage),
    brandDiscounts,
  };
}

/** Agrupa la página de productos por marca conservando el orden de llegada. */
export function groupProductsByBrand(
  products: OrderCatalogProduct[],
  brandNameById: Map<string, string>,
): BrandProductGroup[] {
  const groups = new Map<string, BrandProductGroup>();

  for (const product of products) {
    const brandId = getBrandId(product.brandId);
    const brandName =
      (typeof product.brandId === 'object' && product.brandId !== null
        ? product.brandId.name
        : undefined) ||
      brandNameById.get(brandId) ||
      'General';

    let group = groups.get(brandId);
    if (!group) {
      group = { brandId, brandName, products: [] };
      groups.set(brandId, group);
    }
    group.products.push(product);
  }

  return Array.from(groups.values());
}

/** Unidades totales y cantidad de productos distintos con cantidad > 0. */
export function countSelectedItems(quantities: QuantityMap): { units: number; distinct: number } {
  let units = 0;
  let distinct = 0;

  for (const quantity of Object.values(quantities)) {
    if (quantity > 0) {
      units += quantity;
      distinct += 1;
    }
  }

  return { units, distinct };
}

/** Línea del carrito; `product` queda en null mientras se recupera del servidor. */
export interface SelectedOrderLine {
  productId: string;
  quantity: number;
  product: OrderCatalogProduct | null;
}

/**
 * Líneas del carrito en el orden en que se cargaron. Incluye los productos que
 * todavía no están en `productCache` para que la UI pueda mostrar su carga en
 * vez de esconder la línea.
 */
export function getSelectedOrderLines(
  quantities: QuantityMap,
  productCache: Record<string, OrderCatalogProduct>,
): SelectedOrderLine[] {
  const lines: SelectedOrderLine[] = [];

  for (const [productId, quantity] of Object.entries(quantities)) {
    if (quantity <= 0) continue;
    lines.push({ productId, quantity, product: productCache[productId] ?? null });
  }

  return lines;
}

/**
 * Productos del carrito que ya están en caché, en el orden de carga. Es la base
 * del filtro "Seleccionados" del catálogo: nunca dispara un fetch por sí solo,
 * porque la recuperación de faltantes ya la hace `useOrderCatalog`.
 */
export function getSelectedCatalogProducts(
  quantities: QuantityMap,
  productCache: Record<string, OrderCatalogProduct>,
): OrderCatalogProduct[] {
  const products: OrderCatalogProduct[] = [];

  for (const [productId, quantity] of Object.entries(quantities)) {
    if (quantity <= 0) continue;
    const product = productCache[productId];
    if (product) products.push(product);
  }

  return products;
}

/**
 * Resuelve el descuento efectivo de una línea con la precedencia
 * manual del producto > marca > general. El map por producto se consulta
 * primero (incluido 0%) y el resto lo resuelve `lib/discounts.ts`.
 */
export function resolveItemDiscount(
  productId: string,
  brandId: string,
  itemDiscounts: DiscountMap,
  brandDiscounts: DiscountMap,
  generalDiscount: number,
): number {
  const itemDiscount = itemDiscounts[productId];
  if (itemDiscount !== undefined && !Number.isNaN(itemDiscount)) {
    return itemDiscount;
  }
  return resolveBrandDiscountPercentage(brandId, brandDiscounts, generalDiscount);
}

/**
 * Descuento efectivo de una tarjeta del catálogo: el override manual manda
 * (incluido 0%) y, si el campo está vacío, rige el descuento de la marca.
 */
export function resolveCardDiscount(disc: string | number, defaultDiscount: number): number {
  if (disc === '') return clampDiscount(defaultDiscount);

  const parsed = typeof disc === 'number' ? disc : Number.parseFloat(disc);
  return clampDiscount(Number.isFinite(parsed) ? parsed : defaultDiscount);
}

/**
 * Subtotal visible de una línea en la tarjeta móvil. Mantiene la misma
 * fórmula que el total del pedido: precio × cantidad × (1 - descuento).
 */
export function calculateLineSubtotal(
  price: number,
  quantity: number,
  discountPercentage: number,
): number {
  const safePrice = Number.isFinite(price) ? price : 0;
  const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  return (safePrice * safeQuantity * (100 - clampDiscount(discountPercentage))) / 100;
}

/**
 * Totales del pedido en una sola pasada O(n) sobre los ítems del carrito.
 * También separa el descuento por origen para mostrarlo en el resumen.
 */
export function calculateOrderTotals({
  quantities,
  productCache,
  itemDiscounts,
  brandDiscounts,
  generalDiscount,
}: {
  quantities: QuantityMap;
  productCache: Record<string, OrderCatalogProduct>;
  itemDiscounts: DiscountMap;
  brandDiscounts: DiscountMap;
  generalDiscount: number;
}): OrderTotals {
  let subtotal = 0;
  let totalDiscount = 0;
  const discountBySource: DiscountBySource = { general: 0, brand: 0, item: 0 };

  for (const [productId, quantity] of Object.entries(quantities)) {
    if (quantity <= 0) continue;
    const product = productCache[productId];
    if (!product) continue;

    const lineSubtotal = product.price * quantity;
    subtotal += lineSubtotal;

    const brandId = getBrandId(product.brandId);
    const discount = resolveItemDiscount(
      productId,
      brandId,
      itemDiscounts,
      brandDiscounts,
      generalDiscount,
    );

    const source: keyof DiscountBySource =
      itemDiscounts[productId] !== undefined && !Number.isNaN(itemDiscounts[productId])
        ? 'item'
        : brandDiscounts[brandId] !== undefined && !Number.isNaN(brandDiscounts[brandId])
          ? 'brand'
          : 'general';

    const lineDiscount = (lineSubtotal * discount) / 100;
    totalDiscount += lineDiscount;
    discountBySource[source] += lineDiscount;
  }

  return {
    subtotal,
    totalDiscount,
    finalTotal: subtotal - totalDiscount,
    discountBySource,
  };
}

/**
 * Construye los ítems del POST /api/orders. Devuelve también los productos que
 * todavía no están en caché para que la página pueda avisar en vez de enviar
 * líneas incompletas.
 */
export function buildOrderItems({
  quantities,
  productCache,
  itemDiscounts,
  brandDiscounts,
  generalDiscount,
}: {
  quantities: QuantityMap;
  productCache: Record<string, OrderCatalogProduct>;
  itemDiscounts: DiscountMap;
  brandDiscounts: DiscountMap;
  generalDiscount: number;
}): BuildOrderItemsResult {
  const selectedEntries = Object.entries(quantities).filter(([, quantity]) => quantity > 0);
  const missingProductIds = selectedEntries
    .filter(([productId]) => !productCache[productId])
    .map(([productId]) => productId);

  const items = selectedEntries
    .filter(([productId]) => productCache[productId])
    .map(([productId, requestedQuantity]) => {
      const product = productCache[productId];
      const brandId = getBrandId(product.brandId);

      return {
        productId,
        requestedQuantity,
        customDiscount: resolveItemDiscount(
          productId,
          brandId,
          itemDiscounts,
          brandDiscounts,
          generalDiscount,
        ),
      };
    });

  return { items, missingProductIds };
}

/**
 * IDs del carrito que todavía no están en caché y nunca se pidieron al
 * servidor, en lotes de hasta 200 (límite de GET /api/products?ids=).
 */
export function collectMissingProductIds(
  quantities: QuantityMap,
  productCache: Record<string, OrderCatalogProduct>,
  requested: Set<string>,
  batchSize = 200,
): string[] {
  const missing: string[] = [];

  for (const [productId, quantity] of Object.entries(quantities)) {
    if (quantity <= 0 || productCache[productId] || requested.has(productId)) continue;
    missing.push(productId);
    if (missing.length >= batchSize) break;
  }

  return missing;
}
