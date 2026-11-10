/**
 * Configuración de las bandejas de pedidos de depósito y facturación.
 *
 * Toda la diferencia entre ambas pantallas (estados, textos y acentos) vive
 * acá; `OrdersTray` y `useOrderTray` son el código compartido. Mantener los
 * datos fuera del componente permite probarlos sin renderizar React.
 */

import {
  DASHBOARD_TIME_ZONE,
  getCalendarDate,
  getCalendarDayRange,
  shiftCalendarDate,
  type CalendarDate,
} from './dashboard-time';
import { ORDER_STATUSES, type OrderStatus } from './order-statuses';
import type { UserRole } from './authz';

export type OrdersTrayVariant = 'deposit' | 'billing' | 'vendor';
export type OrdersTrayRole = 'deposit' | 'billing' | 'vendor' | 'all';

/** Valor de un chip de sub-estado: `all` conserva la lista de la variante. */
export type OrdersTrayStatusFilterValue = 'all' | OrderStatus;

export interface OrdersTrayStatusFilter {
  value: OrdersTrayStatusFilterValue;
  label: string;
}

export interface OrdersTrayConfig {
  variant: OrdersTrayVariant;
  /** Estados separados por coma que acepta GET /api/orders. */
  status: string;
  /** Chips horizontales de sub-estado, siempre empezando por `all`. */
  statusFilters: readonly OrdersTrayStatusFilter[];
  pageTitle: string;
  iconClassName: string;
  notificationsRole: OrdersTrayRole;
  heading: string;
  subtitle: string;
  searchPlaceholder: string;
  searchFocusClass: string;
  archiveFilterActiveClass: string;
  archiveIconClass: string;
  refreshIconClass: string;
  emptyIconClass: string;
  loadingLabel: string;
  emptyDescription: string;
  /** Entidad usada en las confirmaciones: "pedido" o "pedido/factura". */
  archiveEntity: string;
  /** La tarjeta completa navega al detalle en las tres bandejas. */
  clickable: boolean;
  detailHref: (orderId: string) => string;
  emptyTitle: (archived: boolean) => string;
}

export const ORDERS_TRAY_CONFIGS: Record<OrdersTrayVariant, OrdersTrayConfig> = {
  deposit: {
    variant: 'deposit',
    status: 'borrador,paralizado',
    statusFilters: [
      { value: 'all', label: 'Todos' },
      { value: 'borrador', label: 'Borrador' },
      { value: 'paralizado', label: 'Paralizado' },
    ],
    pageTitle: 'Bandeja de Depósito',
    iconClassName: 'text-emerald-400',
    notificationsRole: 'deposit',
    heading: 'Pedidos Pendientes de Picking',
    subtitle: 'Verifique la mercadería y gestione faltantes o backorders a gran escala.',
    searchPlaceholder: 'Buscar por cliente, producto, código o #pedido...',
    searchFocusClass: 'focus:ring-emerald-500',
    archiveFilterActiveClass: 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300',
    archiveIconClass: 'text-emerald-400',
    refreshIconClass: 'text-emerald-400',
    emptyIconClass: 'text-emerald-500/40',
    loadingLabel: 'Cargando pedidos...',
    emptyDescription: 'Todos los pedidos han sido verificados o facturados.',
    archiveEntity: 'pedido',
    clickable: true,
    detailHref: (orderId) => `/deposit/orders/${orderId}`,
    emptyTitle: (archived) =>
      `No hay pedidos ${archived ? 'archivados' : 'pendientes en depósito'}`,
  },
  billing: {
    variant: 'billing',
    status: 'facturacion,control_post_factura,entregado',
    statusFilters: [
      { value: 'all', label: 'Todos' },
      { value: 'facturacion', label: 'Para facturar' },
      { value: 'control_post_factura', label: 'Post-control' },
      { value: 'entregado', label: 'Entregados' },
    ],
    pageTitle: 'Bandeja de Facturación',
    iconClassName: 'text-purple-400',
    notificationsRole: 'billing',
    heading: 'Bandeja de Facturación y Cierre',
    subtitle: 'Optimizado para miles de facturas y control a largo plazo.',
    searchPlaceholder: 'Buscar por cliente, producto, código o #factura...',
    searchFocusClass: 'focus:ring-purple-500',
    archiveFilterActiveClass: 'bg-purple-600/20 border-purple-500/50 text-purple-300',
    archiveIconClass: 'text-purple-400',
    refreshIconClass: 'text-purple-400',
    emptyIconClass: 'text-purple-500/40',
    loadingLabel: 'Cargando pedidos para facturación...',
    emptyDescription: 'Los pedidos verificados por depósito aparecerán aquí automáticamente.',
    archiveEntity: 'pedido/factura',
    clickable: true,
    detailHref: (orderId) => `/billing/orders/${orderId}`,
    emptyTitle: (archived) =>
      `No hay pedidos ${archived ? 'archivados' : 'pendientes de facturación'}`,
  },
  vendor: {
    variant: 'vendor',
    // "Mis pedidos" muestra el ciclo completo; el estado se refleja en cada
    // tarjeta y el filtro de archivados sigue siendo independiente.
    status: ORDER_STATUSES.join(','),
    statusFilters: [
      { value: 'all', label: 'Todos' },
      { value: 'borrador', label: 'Borrador' },
      { value: 'paralizado', label: 'Paralizado' },
      { value: 'facturacion', label: 'En facturación' },
      { value: 'control_post_factura', label: 'Post-control' },
      { value: 'entregado', label: 'Entregados' },
    ],
    pageTitle: 'Mis Pedidos',
    iconClassName: 'text-blue-400',
    notificationsRole: 'vendor',
    heading: 'Historial de Mis Pedidos',
    subtitle: 'Consultá el estado, los importes y el detalle de los pedidos que creaste.',
    searchPlaceholder: 'Buscar por cliente, producto, código o #pedido...',
    searchFocusClass: 'focus:ring-blue-500',
    archiveFilterActiveClass: 'bg-blue-600/20 border-blue-500/50 text-blue-300',
    archiveIconClass: 'text-blue-400',
    refreshIconClass: 'text-blue-400',
    emptyIconClass: 'text-blue-500/40',
    loadingLabel: 'Cargando tus pedidos...',
    emptyDescription: 'Los pedidos que crees aparecerán acá automáticamente.',
    archiveEntity: 'pedido',
    clickable: true,
    detailHref: (orderId) => `/orders/${orderId}`,
    emptyTitle: (archived) =>
      archived ? 'No hay pedidos archivados' : 'Todavía no creaste pedidos',
  },
};

/** Presets rápidos de fecha compartidos por la UI, el listado y la exportación. */
export const ORDERS_TRAY_DATE_FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'today', label: 'Hoy' },
  { value: 'last7', label: 'Últimos 7 días' },
  { value: 'month', label: 'Este mes' },
] as const;

export type OrdersTrayDatePreset = (typeof ORDERS_TRAY_DATE_FILTERS)[number]['value'];

/** Filtros de bandeja que viajan en la URL y sobreviven a la navegación. */
export interface OrdersTrayFilters {
  status: OrdersTrayStatusFilterValue;
  datePreset: OrdersTrayDatePreset;
  showArchived: boolean;
  /** Término libre de búsqueda; vacío cuando la bandeja no filtra. */
  search?: string;
}

/** Query params que lee una bandeja al montar desde el servidor o la URL. */
export interface OrdersTrayQueryParams {
  status?: string | string[] | null;
  date?: string | string[] | null;
  archived?: string | string[] | null;
  search?: string | string[] | null;
}

/** Largo máximo del término de búsqueda que viaja en la URL. */
const MAX_ORDERS_TRAY_SEARCH_LENGTH = 80;

/** Normaliza el término libre: sin espacios externos y acotado para la URL. */
export function normalizeOrdersTraySearch(requested: string | string[] | null | undefined): string {
  const value = Array.isArray(requested) ? requested[0] : requested;

  return typeof value === 'string' ? value.trim().slice(0, MAX_ORDERS_TRAY_SEARCH_LENGTH) : '';
}

/** Resuelve el chip de fecha desde `?date=...`; valores ajenos caen a Todas. */
export function resolveOrdersTrayDatePreset(
  requested: string | string[] | null | undefined,
): OrdersTrayDatePreset {
  const value = Array.isArray(requested) ? requested[0] : requested;
  const match = ORDERS_TRAY_DATE_FILTERS.find((filter) => filter.value === value);

  return match?.value ?? 'all';
}

/** `?archived=1` (o `true`) abre la bandeja en modo archivados. */
export function resolveOrdersTrayArchived(
  requested: string | string[] | null | undefined,
): boolean {
  const value = Array.isArray(requested) ? requested[0] : requested;

  return value === '1' || value === 'true';
}

/** Filtros iniciales completos de una bandeja resueltos desde `searchParams`. */
export function resolveOrdersTrayInitialFilters(
  config: Pick<OrdersTrayConfig, 'statusFilters'>,
  params: OrdersTrayQueryParams,
): OrdersTrayFilters {
  return {
    status: resolveOrdersTrayStatusFilter(config, params.status).value,
    datePreset: resolveOrdersTrayDatePreset(params.date),
    showArchived: resolveOrdersTrayArchived(params.archived),
    search: normalizeOrdersTraySearch(params.search),
  };
}

/**
 * Aplica los filtros de bandeja sobre la query actual sin pisar otros params.
 * Los valores por defecto se omiten para mantener URLs limpias y compartibles.
 */
export function buildOrdersTrayFilterSearchParams(
  filters: OrdersTrayFilters,
  current: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const params = new URLSearchParams(current);

  if (filters.status === 'all') params.delete('status');
  else params.set('status', filters.status);

  if (filters.datePreset === 'all') params.delete('date');
  else params.set('date', filters.datePreset);

  if (filters.showArchived) params.set('archived', '1');
  else params.delete('archived');

  const search = filters.search?.trim();
  if (search) params.set('search', search);
  else params.delete('search');

  return params;
}

/** URL de la bandeja con sus filtros activos. */
export function buildOrdersTrayHref(basePath: string, filters: OrdersTrayFilters): string {
  const query = buildOrdersTrayFilterSearchParams(filters).toString();

  return query ? `${basePath}?${query}` : basePath;
}

export interface OrdersTrayDateRange {
  /** ISO con hora; `null` cuando el preset no acota el rango. */
  startDate: string | null;
  endDate: string | null;
}

/** Resuelve el chip inicial desde `?status=...`; los valores ajenos caen a Todos. */
export function resolveOrdersTrayStatusFilter(
  config: Pick<OrdersTrayConfig, 'statusFilters'>,
  requested: string | string[] | null | undefined,
): OrdersTrayStatusFilter {
  const value = Array.isArray(requested) ? requested[0] : requested;
  const match = config.statusFilters.find((filter) => filter.value === value);
  const fallback = config.statusFilters.find((filter) => filter.value === 'all');

  return match ?? fallback ?? config.statusFilters[0]!;
}

/** Estados que se envían a la API para el chip activo. */
export function getOrdersTrayStatusParam(
  config: Pick<OrdersTrayConfig, 'status' | 'statusFilters'>,
  filter: OrdersTrayStatusFilterValue,
): string {
  if (filter === 'all') return config.status;
  const allowed = config.statusFilters.some((option) => option.value === filter);

  return allowed ? filter : config.status;
}

function dateRangeParams(start: Date, endExclusive: Date): OrdersTrayDateRange {
  return {
    startDate: start.toISOString(),
    endDate: new Date(endExclusive.getTime() - 1).toISOString(),
  };
}

function monthStartDate(date: CalendarDate): CalendarDate {
  return { year: date.year, month: date.month, day: 1 };
}

/**
 * Rango de fechas del preset en el día comercial argentino. Se envían
 * instantes ISO completos: el servidor no los recorta al horario del proceso.
 */
export function resolveOrdersTrayDateRange(
  preset: OrdersTrayDatePreset,
  now: Date = new Date(),
  timeZone: string = DASHBOARD_TIME_ZONE,
): OrdersTrayDateRange {
  if (preset === 'all') return { startDate: null, endDate: null };

  const today = getCalendarDate(now, timeZone);
  const todayRange = getCalendarDayRange(today, timeZone);

  if (preset === 'today') return dateRangeParams(todayRange.start, todayRange.end);

  if (preset === 'last7') {
    const firstDay = shiftCalendarDate(today, -6);
    return dateRangeParams(getCalendarDayRange(firstDay, timeZone).start, todayRange.end);
  }

  const monthStart = getCalendarDayRange(monthStartDate(today), timeZone).start;
  const nextMonth = {
    year: today.month === 12 ? today.year + 1 : today.year,
    month: today.month === 12 ? 1 : today.month + 1,
    day: 1,
  };
  const monthEnd = getCalendarDayRange(nextMonth, timeZone).start;

  return dateRangeParams(monthStart, monthEnd);
}

export interface OrdersListSearchParamsInput {
  status: string;
  archived: boolean;
  search?: string;
  startDate?: string | null;
  endDate?: string | null;
  limit: number;
  cursor?: string | null;
}

/** Query de GET /api/orders usada por la bandeja y su paginación. */
export function buildOrdersListSearchParams(input: OrdersListSearchParamsInput): URLSearchParams {
  const params = new URLSearchParams({
    status: input.status,
    archived: input.archived ? 'true' : 'false',
    limit: String(input.limit),
    pagination: 'cursor',
  });
  const search = input.search?.trim();
  if (search) params.set('search', search);
  if (input.startDate) params.set('startDate', input.startDate);
  if (input.endDate) params.set('endDate', input.endDate);
  if (input.cursor) params.set('cursor', input.cursor);

  return params;
}

/**
 * Destino de una tarjeta de "Colas por estado": el vendedor siempre va a su
 * historial; el resto a la bandeja operativa que gestiona ese estado.
 */
export function buildDashboardQueueHref(role: UserRole, status: OrderStatus): string {
  const base =
    role === 'vendedor'
      ? '/orders'
      : status === 'borrador' || status === 'paralizado'
        ? '/deposit/orders'
        : '/billing/orders';

  return `${base}?status=${encodeURIComponent(status)}`;
}

export interface ArchiveConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'primary';
}

/** Textos del ConfirmDialog para archivar o desarchivar una tarjeta. */
export function buildArchiveConfirmation(
  archiveEntity: string,
  archived: boolean | undefined,
): ArchiveConfirmation {
  const nextArchived = !archived;
  const verb = nextArchived ? 'archivar' : 'desarchivar';
  const label = nextArchived ? 'Archivar' : 'Desarchivar';

  return {
    title: `${label} ${archiveEntity}`,
    message: `¿Estás seguro de ${verb} este ${archiveEntity}?`,
    confirmLabel: label,
    variant: 'primary',
  };
}

export interface DeleteConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger';
}

/** Textos del ConfirmDialog para eliminar una tarjeta. */
export const DELETE_CONFIRMATION: DeleteConfirmation = {
  title: 'Eliminar pedido',
  message: '¿Estás seguro de eliminar este pedido? Esta acción no se puede deshacer.',
  confirmLabel: 'Eliminar',
  variant: 'danger',
};

const FILTERS_STORAGE_PREFIX = 'sgi_orders_tray_filters:';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;

  try {
    return window.sessionStorage;
  } catch {
    // Almacenamiento bloqueado (modo privado): se degrada a volver sin filtros.
    return null;
  }
}

function normalizeTrayPath(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/, '') || '/';
}

/**
 * Recuerda los filtros de una bandeja en la pestaña actual. El detalle los usa
 * para que "Volver" aterrice en el mismo estado y no en la bandeja limpia.
 */
export function saveOrdersTrayFilters(
  path: string,
  filters: OrdersTrayFilters,
  storage?: StorageLike,
): void {
  const target = resolveStorage(storage);
  if (!target) return;

  try {
    target.setItem(`${FILTERS_STORAGE_PREFIX}${normalizeTrayPath(path)}`, JSON.stringify(filters));
  } catch {
    // Sin sessionStorage la navegación sigue funcionando, sólo pierde el filtro.
  }
}

/** Lee los filtros guardados para `path`, descartando valores corruptos. */
export function readOrdersTrayFilters(
  path: string,
  storage?: StorageLike,
): OrdersTrayFilters | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  try {
    const raw = target.getItem(`${FILTERS_STORAGE_PREFIX}${normalizeTrayPath(path)}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<OrdersTrayFilters>;
    const status = parsed.status;
    const validStatus =
      status === 'all' ||
      (typeof status === 'string' && (ORDER_STATUSES as readonly string[]).includes(status));

    if (!validStatus) return null;

    return {
      status: status as OrdersTrayStatusFilterValue,
      datePreset:
        typeof parsed.datePreset === 'string'
          ? resolveOrdersTrayDatePreset(parsed.datePreset)
          : 'all',
      showArchived: parsed.showArchived === true,
      search: normalizeOrdersTraySearch(parsed.search),
    };
  } catch {
    return null;
  }
}

/** Destino de "Volver" del detalle: la bandeja base con los últimos filtros. */
export function getOrdersTrayBackHref(path: string, storage?: StorageLike): string {
  const basePath = normalizeTrayPath(path);
  const filters = readOrdersTrayFilters(basePath, storage);

  return filters ? buildOrdersTrayHref(basePath, filters) : basePath;
}
