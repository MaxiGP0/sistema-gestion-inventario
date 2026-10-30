/**
 * Etiquetas legibles de los estados de un pedido.
 *
 * Vive en un módulo sin dependencias de servidor para poder usarse tanto en
 * pantallas server como en componentes cliente (por ejemplo, la hoja de
 * impresión). `lib/dashboard.ts` reutiliza este mapa para sus KPIs.
 */

import type { OrderStatus } from './order-statuses';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  borrador: 'Borrador',
  paralizado: 'Paralizado',
  facturacion: 'Listo para facturar',
  control_post_factura: 'Control post-factura',
  entregado: 'Entregado',
};
