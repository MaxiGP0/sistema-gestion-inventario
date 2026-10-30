/**
 * Fuente única de los estados de un pedido: whitelist, transiciones del ciclo
 * de vida y helpers de validación.
 *
 * La usan el schema de Mongoose (models/Order.ts) y los schemas Zod
 * (lib/validations.ts reexporta todo para no romper los imports existentes).
 *
 * Transiciones permitidas (documento técnico §4.4):
 * borrador -> paralizado | facturacion -> control_post_factura -> entregado,
 * con `paralizado` como estado de retención por faltantes.
 * Mantener el estado actual siempre es válido (re-guardar picking, comentar, archivar).
 */

export const ORDER_STATUSES = [
  'borrador',
  'paralizado',
  'facturacion',
  'control_post_factura',
  'entregado',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  borrador: ['paralizado', 'facturacion'],
  paralizado: ['facturacion'],
  facturacion: ['control_post_factura', 'entregado'],
  control_post_factura: ['entregado'],
  entregado: [],
};

export function canTransitionOrderStatus(current: OrderStatus, next: OrderStatus): boolean {
  if (current === next) return true;
  return ORDER_STATUS_TRANSITIONS[current]?.includes(next) ?? false;
}

export function getOrderStatusTransitionError(
  current: OrderStatus,
  next: OrderStatus,
): string | null {
  if (canTransitionOrderStatus(current, next)) return null;
  return `Transición de estado inválida: no se puede pasar de "${current}" a "${next}"`;
}
