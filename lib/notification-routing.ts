/**
 * Destino de navegación de las notificaciones con pedido asociado.
 *
 * El dashboard (rol 'all') recibe notificaciones de todas las bandejas y el
 * detalle del pedido vive en rutas separadas, así que el destino se infiere
 * del `targetRole` con el que se creó la notificación:
 *   - 'deposit' -> /deposit/orders/:id (bandeja histórica del controlador)
 *   - 'billing' -> /billing/orders/:id
 *   - 'vendor'  -> /orders/:id (bandeja privada del vendedor)
 *
 * En una bandeja concreta manda el rol actual: una notificación global ('all')
 * se abre en la bandeja en la que está el usuario. `controlador` se acepta
 * como alias de la bandeja histórica `deposit` y `vendedor` como alias de
 * `vendor`; los valores persistidos de las notificaciones siguen siendo
 * `deposit | billing | vendor | all`.
 *
 * El 'all' como destino (o un rol desconocido) es ambiguo: la función devuelve
 * null y la UI ofrece elegir la bandeja.
 */

export type NotificationRole =
  'deposit' | 'controlador' | 'billing' | 'vendor' | 'vendedor' | 'all';

export interface OrderNotificationInput {
  /** Rol de la pantalla desde la que se abre la notificación. */
  currentRole: NotificationRole;
  /** Rol destinatario con el que se creó la notificación. */
  targetRole: string;
  /** Pedido asociado; sin él no hay navegación. */
  orderId?: string | null;
}

export function resolveOrderHref({
  currentRole,
  targetRole,
  orderId,
}: OrderNotificationInput): string | null {
  if (!orderId) return null;

  const role = currentRole === 'all' ? targetRole : currentRole;

  if (role === 'deposit' || role === 'controlador') return `/deposit/orders/${orderId}`;
  if (role === 'billing') return `/billing/orders/${orderId}`;
  if (role === 'vendor' || role === 'vendedor') return `/orders/${orderId}`;
  return null;
}
