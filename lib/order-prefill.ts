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
import type { OrderDTO, OrderItemDTO } from './types';

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
 * Convierte el detalle de un pedido en el estado inicial del carrito.
 *
 * - Suma cantidades si el pedido repite un producto en más de una línea.
 * - Omite productos con baja lógica o inexistentes y los reporta.
 * - Usa la ficha del cliente que vino poblada en el pedido; si el cliente fue
 *   eliminado, busca una coincidencia por código/nombre en el listado recibido.
 */
export function buildOrderPrefill(
  order: OrderDTO,
  knownClients: readonly OrderCatalogClient[] = [],
): OrderPrefill {
  const populatedClient =
    order.clientId && typeof order.clientId === 'object' ? order.clientId : null;

  const fallbackClient =
    (order.clientCode
      ? knownClients.find((client) => client.code === order.clientCode)
      : undefined) ??
    (order.clientName
      ? knownClients.find((client) => client.name === order.clientName)
      : undefined);

  const client: OrderCatalogClient | null = populatedClient?._id
    ? ({
        ...populatedClient,
        _id: populatedClient._id,
        code: populatedClient.code,
        name: populatedClient.name,
        address: populatedClient.address,
        localidad: populatedClient.localidad,
        province: populatedClient.province,
        generalDiscount: populatedClient.generalDiscount,
        brandDiscounts: populatedClient.brandDiscounts,
      } as OrderCatalogClient)
    : (fallbackClient ?? null);

  const quantities: QuantityMap = {};
  const omittedItems: OrderPrefillOmittedItem[] = [];

  for (const item of order.items) {
    const requestedQuantity = Number(item.requestedQuantity) || 0;
    if (requestedQuantity <= 0) continue;

    const omitted = omitReason(item);
    if (omitted) {
      omittedItems.push({
        productId: item.productId?._id ?? '',
        productCode: item.productCode ?? item.productId?.code,
        productName: item.productName ?? item.productId?.name,
        requestedQuantity,
        reason: omitted,
      });
      continue;
    }

    const productId = item.productId!._id;
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

function omitReason(item: OrderItemDTO): OrderPrefillOmittedItem['reason'] | null {
  if (!item.productId?._id) return 'not_found';
  if (item.productId.active === false) return 'inactive';
  return null;
}
