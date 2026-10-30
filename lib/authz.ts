/**
 * Fuente única de los roles de usuario y de las reglas de autorización.
 *
 * Es un módulo puro (sin dependencias de Node ni de Next) para poder usarlo
 * tanto en el proxy (proxy.ts), como en los route handlers, en el modelo de
 * User y en los componentes cliente (etiquetas de rol).
 *
 * Matriz de permisos acordada:
 * - admin:       todo (catálogo, pedidos, picking y facturación).
 * - vendedor:    crea pedidos y comenta/archiva; no verifica ni factura.
 * - controlador: verifica y paraliza pedidos; no pasa a control post-factura
 *                ni entrega (no factura).
 * - billing:     controla post-factura y entrega; no verifica cantidades
 *                (no toca ítems del picking).
 *
 * El rol legado `deposit` se normaliza a `controlador` para no invalidar
 * usuarios ni sesiones existentes. Las rutas `/deposit/**` conservan ese
 * nombre histórico.
 */

export const USER_ROLES = ['admin', 'vendedor', 'controlador', 'billing'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  vendedor: 'Vendedor',
  controlador: 'Controlador',
  billing: 'Facturación',
};

/** Valor persistido por versiones anteriores para el rol de control/picking. */
export const LEGACY_DEPOSIT_ROLE = 'deposit' as const;

/** Estados que solo puede aplicar el controlador (picking). */
export const CONTROL_ORDER_STATUSES = ['paralizado', 'facturacion'] as const;

/** @deprecated Usar CONTROL_ORDER_STATUSES. Se conserva por compatibilidad. */
export const DEPOSIT_ORDER_STATUSES = CONTROL_ORDER_STATUSES;

/** Estados que solo puede aplicar facturación (control post-factura). */
export const BILLING_ORDER_STATUSES = ['control_post_factura', 'entregado'] as const;

/** Roles que pueden marcar el control post-factura de cada línea. */
export const POST_CONTROL_ROLES = ['admin', 'billing'] as const;

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Normaliza un rol persistido o firmado en una sesión anterior. El valor
 * legado `deposit` pasa a ser `controlador`; cualquier otro valor solo se
 * devuelve si es un rol canónico. Los valores desconocidos devuelven `null`.
 */
export function normalizeUserRole(value: unknown): UserRole | null {
  if (value === LEGACY_DEPOSIT_ROLE) return 'controlador';
  return isUserRole(value) ? value : null;
}

/**
 * Rol efectivo de un usuario. Los usuarios creados antes de esta iteración no
 * tienen `role`; la migración suave asigna `admin` al usuario histórico
 * "admin" y `vendedor` al resto. Un `deposit` persistido se migra a
 * `controlador`.
 */
export function resolveUserRole(role: unknown, username?: string): UserRole {
  const normalized = normalizeUserRole(role);
  if (normalized) return normalized;

  return username?.trim().toLowerCase() === 'admin' ? 'admin' : 'vendedor';
}

/** ¿Puede crear pedidos? */
export function canCreateOrder(role: UserRole): boolean {
  return role === 'admin' || role === 'vendedor';
}

/**
 * ¿Puede administrar el catálogo (marcas, productos, edición/eliminación de
 * clientes e importación)? El alta de clientes tiene su propia regla.
 */
export function canManageCatalog(role: UserRole): boolean {
  return role === 'admin';
}

/**
 * ¿Puede dar de alta un cliente desde el flujo de pedidos? El vendedor puede
 * crear la ficha para no abandonar el alta; editar y eliminar siguen siendo
 * exclusivos del backoffice de administración.
 */
export function canCreateClient(role: UserRole): boolean {
  return role === 'admin' || role === 'vendedor';
}

/** ¿Puede hard-eliminar pedidos? Acción destructiva: solo admin. */
export function canDeleteOrder(role: UserRole): boolean {
  return role === 'admin';
}

/**
 * Contexto de una edición integral de un borrador. El vendedor titular puede
 * ajustar ítems y datos comerciales sólo mientras depósito no lo haya tomado.
 */
export interface OrderDraftEditContext {
  /** La sesión es la creadora del pedido (o un admin). */
  isOwner: boolean;
  /** Estado actual del pedido; debe seguir siendo `borrador`. */
  status: string;
  /** Ninguna línea tiene control de depósito ni control post-factura. */
  isIntact: boolean;
}

/** Cambio pretendido sobre un pedido, tal como llega en el PUT. */
export interface OrderUpdateIntent {
  /** El body incluye ítems (picking / verificación o edición del borrador). */
  hasItems: boolean;
  /** Estado destino, si el body incluye uno. */
  targetStatus?: string;
  /** El body incluye tipo de factura o condición de pago. */
  hasCommercialData?: boolean;
  /** Presente sólo en el modo `draft-edit`: edición integral de un borrador. */
  draftEdit?: OrderDraftEditContext;
}

/** ¿Puede marcar el control post-factura de las líneas? */
export function canControlOrderPostItems(role: UserRole): boolean {
  return (POST_CONTROL_ROLES as readonly string[]).includes(role);
}

/**
 * ¿Puede este rol aplicar el cambio pretendido sobre un pedido?
 * Un body sin ítems ni estado es un comentario/archivado: lo puede hacer
 * cualquier rol operativo.
 */
export function canUpdateOrder(role: UserRole, intent: OrderUpdateIntent): boolean {
  // La edición integral del borrador tiene reglas propias: el vendedor titular
  // (o admin) sólo puede tocar ítems/datos comerciales de un pedido que siga
  // en `borrador` y sin picking ni control post-factura iniciados.
  if (intent.draftEdit) {
    const { isOwner, status, isIntact } = intent.draftEdit;
    if (status !== 'borrador' || !isIntact) return false;
    if (role === 'admin') return true;
    return role === 'vendedor' && isOwner;
  }

  if (role === 'admin') return true;

  if (intent.hasCommercialData) {
    // Los datos comerciales sólo se ajustan con el modo de edición de borrador.
    return false;
  }

  if (intent.hasItems) {
    // Verificar cantidades es exclusivo del controlador.
    return role === 'controlador';
  }

  if (!intent.targetStatus) {
    // Comentarios y archivado.
    return role === 'vendedor' || role === 'controlador' || role === 'billing';
  }

  if ((CONTROL_ORDER_STATUSES as readonly string[]).includes(intent.targetStatus)) {
    return role === 'controlador';
  }

  if ((BILLING_ORDER_STATUSES as readonly string[]).includes(intent.targetStatus)) {
    return role === 'billing';
  }

  return false;
}

/** ¿Puede este rol ver la página indicada? (regla de navegación del proxy) */
export function canAccessPage(pathname: string, role: UserRole): boolean {
  if (role === 'admin') return true;

  if (pathname.startsWith('/backoffice')) return false;
  if (pathname.startsWith('/catalog')) return role === 'vendedor' || role === 'controlador';
  if (pathname.startsWith('/deposit')) return role === 'controlador';
  if (pathname.startsWith('/billing')) return role === 'billing';
  if (pathname.startsWith('/orders')) return role === 'vendedor';

  return true;
}
