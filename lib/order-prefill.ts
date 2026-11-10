/**
 * Precarga del carrito de /orders/new a partir de un pedido existente.
 *
 * El vendedor puede repetir un pedido o editar un borrador propio. En ambos
 * casos las líneas se cargan en el formulario (no se crea otro pedido por API):
 * los precios y descuentos se recalculan con el catálogo y la ficha vigente.
 *
 * Es un módulo puro para poder probarlo sin navegador. No decide permisos: la
 * API sigue siendo la autoridad al guardar.
 */

import type { InvoiceType, PaymentCondition } from './order-commercial';
import type { OrderCatalogClient, QuantityMap } from './order-catalog';
import type {
  OrderClientDTO,
  OrderClientSummaryDTO,
  OrderDTO,
  OrderItemDTO,
  OrderItemProductDTO,
  OrderSummaryDTO,
  OrderSummaryItemDTO,
} from './types';

/**
 * Fuente de la precarga: el detalle completo (`OrderDTO`) o el resumen que ya
 * devuelve `GET /api/orders?clientId=…&limit=1`. El resumen incluye
 * `items.productId` escalar, así repetir un pedido no necesita otro request.
 */
export type OrderPrefillSource = OrderDTO | OrderSummaryDTO;
type OrderPrefillItem = OrderItemDTO | OrderSummaryItemDTO;

export interface OrderPrefillOmittedItem {
  productId: string;
  productCode?: string;
  productName?: string;
  requestedQuantity: number;
  reason: 'inactive' | 'not_found';
}

export interface OrderPrefill {
  client: OrderCatalogClient | null;
  quantities: QuantityMap;
  invoiceType: InvoiceType | '';
  paymentCondition: PaymentCondition | '';
  paymentConditionDetail: string;
  /** Productos que no se pudieron cargar (baja lógica o borrado). */
  omittedItems: OrderPrefillOmittedItem[];
}

/** Texto listo para el toast cuando se omitieron líneas. */
export function buildPrefillOmittedMessage(
  omittedItems: readonly OrderPrefillOmittedItem[],
): string | null {
  if (omittedItems.length === 0) return null;

  const labels = omittedItems.slice(0, 3).map((item) => {
    const label = item.productCode ?? item.productName ?? item.productId;
    return `${label} (${item.reason === 'inactive' ? 'inactivo' : 'no encontrado'})`;
  });
  const remaining = omittedItems.length - labels.length;

  return `Se omitieron ${omittedItems.length} producto(s): ${labels.join(', ')}${
    remaining > 0 ? ` y ${remaining} más` : ''
  }.`;
}

/**
 * Id escalar de la línea, venga poblado (`OrderDTO`) o como referencia
 * (`OrderSummaryDTO`). Es la única pieza del producto que necesita el carrito:
 * nombre, precio y descuentos se resuelven con el catálogo vigente.
 */
export function orderItemProductId(item: {
  productId?: string | OrderItemProductDTO | null;
}): string {
  const productId = item.productId;
  if (!productId) return '';
  if (typeof productId === 'string') return productId;
  return productId._id ?? '';
}

function populatedProductId(item: OrderPrefillItem): OrderItemDTO['productId'] {
  const productId = item.productId;
  return productId && typeof productId === 'object' ? productId : null;
}

/**
 * Convierte el detalle o el resumen de un pedido en el estado inicial del
 * carrito.
 *
 * - Suma cantidades si el pedido repite un producto en más de una línea.
 * - Omite productos con baja lógica o inexistentes y los reporta.
 * - Usa la ficha completa del cliente cuando vino poblada en el detalle, la
 *   combina con el listado conocido (descuentos) cuando sólo llegó el resumen,
 *   y cae a una coincidencia por código/nombre si el cliente fue eliminado.
 */
export function buildOrderPrefill(
  order: OrderPrefillSource,
  knownClients: readonly OrderCatalogClient[] = [],
  preferredClient: OrderCatalogClient | null = null,
): OrderPrefill {
  const populatedClient =
    order.clientId && typeof order.clientId === 'object' ? order.clientId : null;
  const populatedClientWithId = populatedClient?._id ? populatedClient : null;

  const knownClient =
    (populatedClientWithId
      ? knownClients.find((client) => client._id === populatedClientWithId._id)
      : undefined) ??
    (order.clientCode
      ? knownClients.find((client) => client.code === order.clientCode)
      : undefined) ??
    (order.clientName
      ? knownClients.find((client) => client.name === order.clientName)
      : undefined);

  const baseClient = preferredClient ?? knownClient ?? null;
  const client = populatedClientWithId
    ? mergePrefillClient(populatedClientWithId, baseClient)
    : baseClient;

  const quantities: QuantityMap = {};
  const omittedItems: OrderPrefillOmittedItem[] = [];

  for (const item of order.items) {
    const requestedQuantity = Number(item.requestedQuantity) || 0;
    if (requestedQuantity <= 0) continue;

    const omitted = omitReason(item);
    if (omitted) {
      const product = populatedProductId(item);
      omittedItems.push({
        productId: orderItemProductId(item),
        productCode: item.productCode ?? product?.code,
        productName: item.productName ?? product?.name,
        requestedQuantity,
        reason: omitted,
      });
      continue;
    }

    const productId = orderItemProductId(item);
    quantities[productId] = (quantities[productId] ?? 0) + requestedQuantity;
  }

  return {
    client,
    quantities,
    invoiceType: order.invoiceType ?? '',
    paymentCondition: order.paymentCondition ?? '',
    paymentConditionDetail: order.paymentConditionDetail ?? '',
    omittedItems,
  };
}

function mergePrefillClient(
  populated: OrderClientDTO | OrderClientSummaryDTO,
  fallback: OrderCatalogClient | null,
): OrderCatalogClient {
  const address = 'address' in populated ? populated.address : undefined;
  const generalDiscount = 'generalDiscount' in populated ? populated.generalDiscount : undefined;
  const brandDiscounts = 'brandDiscounts' in populated ? populated.brandDiscounts : undefined;

  return {
    ...(fallback ?? {}),
    _id: populated._id ?? fallback?._id ?? '',
    code: populated.code ?? fallback?.code ?? '',
    name: populated.name ?? fallback?.name ?? '',
    address: address ?? fallback?.address,
    localidad: populated.localidad ?? fallback?.localidad,
    province: populated.province ?? fallback?.province,
    generalDiscount: generalDiscount ?? fallback?.generalDiscount,
    brandDiscounts: (brandDiscounts ??
      fallback?.brandDiscounts) as OrderCatalogClient['brandDiscounts'],
  };
}

function omitReason(item: OrderPrefillItem): OrderPrefillOmittedItem['reason'] | null {
  if (!orderItemProductId(item)) return 'not_found';
  if (populatedProductId(item)?.active === false) return 'inactive';
  return null;
}
