/**
 * Reglas del alta rápida de productos desde el control de depósito.
 *
 * El operario elige cuántas unidades sumar antes de tocar "Agregar". Si el
 * producto ya está en el pedido sólo se incrementa la cantidad controlada; si
 * es nuevo, la línea se valúa con el descuento vigente del cliente (marca o
 * general) para que el total local coincida con el que calculará el servidor.
 *
 * No depende de React ni de Next para poder probarlo con `node:test`.
 */
import { buildClientDiscountResolver, type ClientDiscountConfigLike } from './discounts';
import { roundCurrency } from './money';
import { setPickingLineQuantity, type ItemControlState } from './picking-control';

export interface DepositCatalogProductLike {
  _id: string;
  code: string;
  name: string;
  price: number;
  priceWithIva?: number;
  imageUrl?: string;
  brandId?: {
    _id?: string;
    name: string;
    codePrefix?: string;
  } | null;
}

export interface DepositOrderItemLike {
  _id?: string;
  productId?: { _id?: string } | null;
  requestedQuantity: number;
  verifiedQuantity?: number;
  itemDiscount?: number;
}

/** Normaliza las unidades a agregar: entero y nunca menor a 1. */
export function normalizeDepositAddQuantity(value: number): number {
  const quantity = Math.trunc(Number.isFinite(value) ? value : 0);
  return Math.max(1, quantity);
}

/** Total de una línea con el descuento porcentual ya resuelto. */
export function depositLineTotal(
  unitPrice: number,
  itemDiscount: number,
  quantity: number,
): number {
  const gross = roundCurrency(unitPrice * quantity);
  const discountAmount = roundCurrency((gross * itemDiscount) / 100);
  return roundCurrency(gross - discountAmount);
}

/** Busca una línea del pedido por el producto del catálogo. */
export function findDepositItemByProductId<T extends DepositOrderItemLike>(
  items: readonly T[],
  productId: string,
): T | undefined {
  return items.find((item) => String(item.productId?._id) === productId);
}

export interface DepositCatalogProductPresence {
  inOrder: boolean;
  quantity: number;
  actionLabel: 'Agregar' | '+ Sumar';
  badgeLabel?: string;
}

/**
 * Estado de una fila del catálogo frente al pedido actual: si el producto ya
 * está cargado se muestra la cantidad pedida y la acción pasa a "sumar".
 */
export function describeDepositCatalogProduct<T extends DepositOrderItemLike>(
  items: readonly T[],
  productId: string,
): DepositCatalogProductPresence {
  const item = findDepositItemByProductId(items, productId);
  if (!item) {
    return { inOrder: false, quantity: 0, actionLabel: 'Agregar' };
  }

  const quantity = Math.max(0, Math.trunc(item.requestedQuantity));
  return {
    inOrder: true,
    quantity,
    actionLabel: '+ Sumar',
    badgeLabel: `En el pedido: ${quantity} u.`,
  };
}

/**
 * Anexa la página siguiente del catálogo sin duplicar productos: la búsqueda
 * online y el snapshot offline pueden solaparse al paginar.
 */
export function appendDepositCatalogProducts<T extends { _id: string }>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  const seen = new Set(current.map((product) => product._id));
  return [...current, ...next.filter((product) => !seen.has(product._id))];
}

/**
 * Una línea sin `_id` todavía no fue guardada: se agregó en esta sesión de
 * depósito. Al sumar unidades su cantidad pedida también avanza.
 */
export function isDepositAddedLine(item: { _id?: string }): boolean {
  return !item._id;
}

export interface DepositAddedItem {
  productCode: string;
  productName: string;
  brandName?: string;
  productId: {
    _id: string;
    code: string;
    name: string;
    price: number;
    priceWithIva?: number;
    imageUrl?: string;
    brandId?: DepositCatalogProductLike['brandId'];
  };
  unitPrice: number;
  requestedQuantity: number;
  verifiedQuantity: number;
  isPending: false;
  itemDiscount: number;
  lineTotal: number;
}

/**
 * Construye la línea local de un producto nuevo en el pedido, con el descuento
 * del cliente aplicado y las cantidades ya controladas en depósito.
 */
export function buildDepositAddedItem(
  product: DepositCatalogProductLike,
  client: ClientDiscountConfigLike | null | undefined,
  qtyToAdd: number,
): DepositAddedItem {
  const quantity = normalizeDepositAddQuantity(qtyToAdd);
  const itemDiscount = buildClientDiscountResolver(client).resolveForBrand(product.brandId);

  return {
    productCode: product.code,
    productName: product.name,
    brandName: product.brandId?.name,
    productId: {
      _id: product._id,
      code: product.code,
      name: product.name,
      price: product.price,
      priceWithIva: product.priceWithIva,
      imageUrl: product.imageUrl,
      brandId: product.brandId,
    },
    unitPrice: product.price,
    requestedQuantity: quantity,
    verifiedQuantity: quantity,
    isPending: false,
    itemDiscount,
    lineTotal: depositLineTotal(product.price, itemDiscount, quantity),
  };
}

export interface DepositExistingAdditionPlan {
  /** Cantidad pedida resultante (avanza sólo en líneas agregadas en depósito). */
  requestedQuantity: number;
  /** Cantidad controlada resultante, para reflejarla en la línea local. */
  verifiedQuantity: number;
  /** Estado de picking ya controlado con las unidades sumadas. */
  state: ItemControlState;
}

/**
 * Suma unidades a una línea existente. Las líneas del servidor conservan su
 * cantidad pedida y sólo aumenta lo verificado; las agregadas en esta sesión
 * de depósito también actualizan lo pedido.
 */
export function planDepositExistingAddition(
  item: DepositOrderItemLike,
  currentState: ItemControlState | undefined,
  qtyToAdd: number,
): DepositExistingAdditionPlan {
  const quantity = normalizeDepositAddQuantity(qtyToAdd);
  const requestedQuantity = isDepositAddedLine(item)
    ? item.requestedQuantity + quantity
    : item.requestedQuantity;
  const baseVerified = currentState?.verifiedQty ?? item.verifiedQuantity ?? item.requestedQuantity;
  const state = setPickingLineQuantity(currentState, baseVerified + quantity, requestedQuantity);

  return {
    requestedQuantity,
    verifiedQuantity: state.verifiedQty,
    state,
  };
}
