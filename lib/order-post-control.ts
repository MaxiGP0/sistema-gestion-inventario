/**
 * Control post-facturación por línea.
 *
 * Cada línea del pedido arranca en `pendiente` y facturación la marca como
 * `ok` o `diferencia` durante el control. El pedido no puede pasar a
 * `entregado` mientras quede al menos una línea sin controlar.
 *
 * Es un módulo puro (sin dependencias de Node ni Next) para compartirlo entre
 * el schema de Mongoose, los schemas Zod, la API y la UI de facturación.
 */

export const POST_CONTROL_VALUES = ['pendiente', 'ok', 'diferencia'] as const;

export type PostControl = (typeof POST_CONTROL_VALUES)[number];

export const POST_CONTROL_LABELS: Record<PostControl, string> = {
  pendiente: 'Pendiente',
  ok: 'OK',
  diferencia: 'Diferencia',
};

export interface PostControllableItem {
  postControl?: PostControl | string | null;
}

/**
 * Normaliza el valor guardado. Los pedidos históricos no tienen el campo, así
 * que cualquier valor ausente o inválido se considera `pendiente`: nunca se
 * habilita la entrega por un dato faltante.
 */
export function resolvePostControl(value: unknown): PostControl {
  return (POST_CONTROL_VALUES as readonly unknown[]).includes(value)
    ? (value as PostControl)
    : 'pendiente';
}

/** ¿La línea todavía no fue controlada en facturación? */
export function isPostControlPending(item: PostControllableItem): boolean {
  return resolvePostControl(item.postControl) === 'pendiente';
}

/** ¿Queda al menos una línea sin controlar? Bloquea el pase a `entregado`. */
export function hasUncontrolledPostItems(items: readonly PostControllableItem[]): boolean {
  return items.some((item) => isPostControlPending(item));
}

/** Cantidad de líneas pendientes de control (para el resumen de la UI). */
export function countUncontrolledPostItems(items: readonly PostControllableItem[]): number {
  return items.reduce((count, item) => (isPostControlPending(item) ? count + 1 : count), 0);
}
