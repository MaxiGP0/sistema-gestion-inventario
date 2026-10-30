/**
 * Bandeja de notificaciones derivada del rol y correspondencia con eventos SSE.
 *
 * Es un módulo puro (sin Node ni modelos) para compartirlo entre el route
 * handler de `/api/events` y `NotificationsBell`. El cliente no puede elegir
 * la bandeja por query: el servidor la resuelve con la sesión firmada.
 */

import type { UserRole } from './authz';
import type { NotificationTargetRole } from './types/notification';

/** Bandeja que corresponde a cada rol autenticado. */
export function notificationInboxForRole(role: UserRole): NotificationTargetRole {
  if (role === 'controlador') return 'deposit';
  if (role === 'billing') return 'billing';
  if (role === 'vendedor') return 'vendor';
  return 'all';
}

/**
 * ¿Un evento con `targetRole` debe refrescar la bandeja `inbox`?
 *
 * `all` es comodín en ambos sentidos: la bandeja global recibe todas las
 * alertas y una alerta global es visible para depósito y facturación. Este es
 * el mismo criterio que `notificationRoleQuery()` usa al listar.
 */
export function notificationMatchesInbox(
  inbox: NotificationTargetRole,
  targetRole: NotificationTargetRole,
): boolean {
  return inbox === 'all' || targetRole === 'all' || inbox === targetRole;
}
