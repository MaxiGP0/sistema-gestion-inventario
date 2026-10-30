'use client';

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import {
  Bell,
  BellOff,
  Settings,
  X,
  CheckCheck,
  Package,
  Inbox,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createVisibilityPoll } from '@/lib/visibility-poll';
import { getRovingIndex, isRovingKey } from '@/lib/focus-trap';
import { notificationMatchesInbox } from '@/lib/notification-inbox';
import { emitOrderNotification } from '@/lib/order-notification-events';
import { resolveOrderHref } from '@/lib/notification-routing';
import { useUser } from '@/context/UserContext';
import { api, isNetworkError } from '@/lib/api-client';
import { DASHBOARD_TIME_ZONE } from '@/lib/dashboard-time';
import type {
  ApiMessageResponse,
  NotificationTargetRole,
  UserNotificationDTO,
  UserNotificationListResponse,
} from '@/lib/types';

/** Cadencia del respaldo por polling cuando el SSE no está disponible. */
const POLL_FALLBACK_MS = 10_000;

/**
 * Polling de seguridad multi-instancia: corre aunque el SSE esté abierto
 * (ver docs/sse-notificaciones.md). Las notificaciones persistidas son la
 * fuente de verdad; el SSE solo reduce la latencia. Con SSE sano se consulta
 * cada 60 s; el respaldo rápido de 10 s queda solo para cuando el canal falla.
 */
const SAFETY_POLL_MS = 60_000;

type Notification = UserNotificationDTO;

const NOTIFICATION_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: DASHBOARD_TIME_ZONE,
});

const NOTIFICATION_DATE_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: 'short',
  timeZone: DASHBOARD_TIME_ZONE,
});

interface NotificationsBellProps {
  currentRole?: 'deposit' | 'billing' | 'vendor' | 'all';
}

export default function NotificationsBell({ currentRole = 'all' }: NotificationsBellProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<NotificationTargetRole>(currentRole);
  // Notificación con destino ambiguo (targetRole 'all') cuyo selector de
  // bandeja está desplegado.
  const [choosingNotificationId, setChoosingNotificationId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Dirección del foco al abrir con teclado (ArrowUp lleva al último ítem).
  const pendingInitialFocusRef = useRef<'first' | 'last'>('first');
  const panelId = useId();
  const panelTitleId = useId();
  const settingsPanelId = useId();
  // Último id SSE procesado: EventSource lo reenvía como Last-Event-ID al
  // reconectar y acá se usa para descartar una posible repetición.
  const lastSeenEventIdRef = useRef('');
  // El efecto SSE no debe reconectarse al cambiar el filtro; el handler lee
  // la bandeja vigente desde este ref.
  const selectedRoleFilterRef = useRef<NotificationTargetRole>(selectedRoleFilter);
  const router = useRouter();
  const { user } = useUser();
  // La bandeja del vendedor es privada: no puede filtrar por depósito o
  // facturación ni elegir otra bandeja. El servidor fuerza el mismo alcance.
  const isVendor = user?.role === 'vendedor';
  const routingRole = isVendor ? 'vendor' : currentRole;
  // Preferencia individual: si está desactivada no se consulta la bandeja ni
  // se abre el canal SSE, y la campana muestra un estado silenciado.
  const notificationsEnabled = user?.notificationsEnabled !== false;

  /** Cierra la bandeja; por defecto devuelve el foco a la campana. */
  const closeDropdown = useCallback((restoreFocus = true) => {
    setShowDropdown(false);
    setChoosingNotificationId(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  // Al abrir, el foco entra en la bandeja para poder recorrerla con el teclado.
  useEffect(() => {
    if (!showDropdown) return;

    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>('[data-notification-item="true"]'),
      );
      const position = pendingInitialFocusRef.current;
      pendingInitialFocusRef.current = 'first';
      const target = position === 'last' ? items[items.length - 1] : items[0];
      (target ?? panel).focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [showDropdown]);

  // Escape cierra la bandeja desde cualquier punto y devuelve el foco.
  useEffect(() => {
    if (!showDropdown) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDropdown();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDropdown, closeDropdown]);

  const fetchNotifications = useCallback(async () => {
    if (!notificationsEnabled) {
      setNotifications([]);
      setNextCursor(null);
      setHasMore(false);
      return;
    }

    // Regla dura: con la pestaña oculta o sin red no se consulta. La puesta al
    // día se hace al volver a primer plano o cuando el polling reintenta.
    if (document.hidden) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    try {
      const data = await api.get<UserNotificationListResponse>(
        `/api/users/notifications?targetRole=${selectedRoleFilter}`,
        { cache: 'no-store' },
      );
      setNotifications(data.notifications);
      setNextCursor(data.pagination?.nextCursor ?? null);
      setHasMore(data.pagination?.hasMore ?? false);
    } catch (err) {
      // Estar sin conexión es un estado esperado: no se registra como error de
      // aplicación (el overlay de desarrollo taparía controles de la página).
      if (!isNetworkError(err)) {
        console.error('Error cargando notificaciones:', err);
      }
    }
  }, [selectedRoleFilter, notificationsEnabled]);

  /** Carga la página siguiente sin duplicar ids que ya estén en pantalla. */
  const loadMoreNotifications = useCallback(async () => {
    if (!nextCursor || loadingMore) return;

    setLoadingMore(true);
    try {
      const data = await api.get<UserNotificationListResponse>(
        `/api/users/notifications?targetRole=${selectedRoleFilter}&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: 'no-store' },
      );
      setNotifications((prev) => {
        const known = new Set(prev.map((notification) => notification._id));
        return [
          ...prev,
          ...data.notifications.filter((notification) => !known.has(notification._id)),
        ];
      });
      setNextCursor(data.pagination?.nextCursor ?? null);
      setHasMore(data.pagination?.hasMore ?? false);
    } catch (err) {
      console.error('Error cargando más notificaciones:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, selectedRoleFilter, loadingMore]);

  // Ref estable: el SSE siempre refresca con el filtro vigente sin reconectar
  // la conexión cada vez que cambia el rol seleccionado.
  const fetchNotificationsRef = useRef(fetchNotifications);

  useEffect(() => {
    fetchNotificationsRef.current = fetchNotifications;
  }, [fetchNotifications]);

  useEffect(() => {
    selectedRoleFilterRef.current = selectedRoleFilter;
  }, [selectedRoleFilter]);

  // Para un vendedor la bandeja siempre es `vendor`, aunque la sesión llegue
  // después del primer render o el prop siga siendo `all` en el dashboard.
  useEffect(() => {
    setSelectedRoleFilter(isVendor ? 'vendor' : currentRole);
  }, [isVendor, currentRole]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Actualizaciones en tiempo real: el backend emite SSE en /api/events cuando
  // crea notificaciones (ver lib/sse.ts). Cada evento lleva `id:`; el navegador
  // reenvía ese valor como Last-Event-ID al reconectar y el servidor reproduce
  // lo que se perdió dentro de su buffer. Aun así, al reconectar se consulta la
  // bandeja persistida para cubrir eventos viejos o generados en otra instancia.
  //
  // Consumo en segundo plano:
  // - Con la pestaña oculta se cierra el EventSource y no corre ningún poller.
  // - Con SSE sano queda un polling de seguridad cada 60 s (multi-instancia).
  // - Si el SSE falla, el respaldo sube a 10 s mientras la pestaña esté visible.
  // Al volver a primer plano se hace una puesta al día y se reabre el SSE.
  useEffect(() => {
    if (!notificationsEnabled) return;

    let sseOpen = false;
    let hadConnected = false;
    let source: EventSource | null = null;
    let connectionLimited = false;
    let lastRefreshAt = 0;

    const poll = createVisibilityPoll({
      intervalMs: POLL_FALLBACK_MS,
      isNeeded: () => !sseOpen,
      isHidden: () => document.hidden,
      onTick: () => fetchNotificationsRef.current(),
    });

    const safetyPoll = createVisibilityPoll({
      intervalMs: SAFETY_POLL_MS,
      isNeeded: () => sseOpen,
      isHidden: () => document.hidden,
      onTick: () => fetchNotificationsRef.current(),
    });

    const syncPolls = () => {
      poll.sync();
      safetyPoll.sync();
    };

    const refreshNow = () => {
      lastRefreshAt = Date.now();
      fetchNotificationsRef.current();
    };

    function closeSource() {
      if (!source) return;

      source.removeEventListener('connection-limit', handleConnectionLimit);
      source.onopen = null;
      source.onerror = null;
      source.onmessage = null;
      source.close();
      source = null;
      sseOpen = false;
    }

    function handleConnectionLimit() {
      // Otra pestaña del mismo usuario/IP nos desalojó. No reintentar (ni al
      // volver a foco): el respaldo de 10 s mantiene la bandeja al día sin
      // guerra de reconexiones.
      connectionLimited = true;
      closeSource();
      syncPolls();
    }

    const connect = () => {
      if (source || connectionLimited || document.hidden) return;

      const nextSource = new EventSource('/api/events');
      source = nextSource;

      nextSource.onopen = () => {
        if (source !== nextSource) return;

        sseOpen = true;
        syncPolls();
        // Puesta al día tras una reconexión. Si el handler de visibilidad ya
        // consultó hace un instante, se evita el request duplicado.
        if (hadConnected && !document.hidden && Date.now() - lastRefreshAt > 1_000) {
          refreshNow();
        }
        hadConnected = true;
      };

      nextSource.onerror = () => {
        // EventSource reintenta solo; mientras tanto el respaldo de 10 s cubre
        // las consultas. El poller de seguridad de 60 s se detiene.
        if (source !== nextSource) return;
        sseOpen = false;
        syncPolls();
      };

      nextSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Deduplicación defensiva: si el servidor repite el último evento que
          // ya habíamos visto, no se vuelve a consultar la bandeja.
          if (event.lastEventId) {
            if (event.lastEventId === lastSeenEventIdRef.current) return;
            lastSeenEventIdRef.current = event.lastEventId;
          }

          if (data?.type !== 'notification') return;

          const targetRole = data.targetRole as NotificationTargetRole | undefined;
          if (!targetRole) return;

          // Los eventos de otra bandeja no deben refrescar esta vista, aunque el
          // servidor ya los filtre para el rol de la sesión.
          if (!notificationMatchesInbox(selectedRoleFilterRef.current, targetRole)) return;

          // Las bandejas de pedidos abiertas escuchan este evento para
          // actualizar su primera página sin abrir otra conexión SSE.
          emitOrderNotification({
            targetRole,
            orderId: typeof data.orderId === 'string' && data.orderId ? data.orderId : null,
          });

          if (!document.hidden) refreshNow();
        } catch {
          // Mensaje que no es JSON: ignorar.
        }
      };

      nextSource.addEventListener('connection-limit', handleConnectionLimit);
    };

    lastSeenEventIdRef.current = '';
    poll.sync();
    connect();
    syncPolls();

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Criterio: sin SSE ni requests periódicos en pestañas ocultas. Cerrar
        // la conexión también evita los reintentos automáticos del navegador.
        closeSource();
        syncPolls();
        return;
      }

      // De vuelta en primer plano: puesta al día, reapertura del SSE y
      // reanudación de los intervalos que correspondan al estado actual.
      refreshNow();
      connect();
      syncPolls();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      closeSource();
      poll.stop();
      safetyPoll.stop();
    };
  }, [notificationsEnabled]);

  // Cerrar al hacer clic fuera en desktop
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        // El clic ya movió el foco: no lo devolvemos a la campana.
        closeDropdown(false);
      }
    };
    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDropdown, closeDropdown]);

  // Clic en una notificación: marca leída y navega al pedido. El destino se
  // resuelve con lib/notification-routing.ts (en el dashboard se infiere por
  // targetRole). Si el destino es ambiguo (targetRole 'all'), despliega el
  // selector de bandeja en lugar de navegar.
  const handleNotificationClick = (n: Notification, orderHref: string | null) => {
    // El marcado como leída no debe demorar ni bloquear la navegación.
    void api
      .put<ApiMessageResponse>('/api/notifications', { id: n._id, read: true })
      .then(() => {
        setNotifications((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: true } : x)));
      })
      .catch((err) => {
        console.error('Error marcando notificación:', err);
      });

    if (orderHref) {
      setShowDropdown(false);
      setChoosingNotificationId(null);
      router.push(orderHref);
      return;
    }

    if (n.orderId) {
      // Destino ambiguo: se ofrece elegir la bandeja.
      setChoosingNotificationId(n._id);
    }
  };

  const handleRoleChoice = (n: Notification, role: 'deposit' | 'billing') => {
    const href = resolveOrderHref({ currentRole: role, targetRole: role, orderId: n.orderId });
    if (!href) return;
    setChoosingNotificationId(null);
    setShowDropdown(false);
    router.push(href);
  };

  const handleMarkAllAsRead = async () => {
    try {
      await api.put<ApiMessageResponse>('/api/notifications', {
        read: true,
        targetRole: selectedRoleFilter,
      });
      // El backend marca la ventana reciente de la bandeja. Se refresca la
      // primera página para reflejar el estado real (incluidas las que no
      // entraban en la ventana de "marcar todas").
      await fetchNotifications();
    } catch (err) {
      console.error('Error marcando todas como leídas:', err);
    }
  };

  const handleClearRead = async () => {
    try {
      // Mismo filtro de bandeja que el listado: no toca las leídas de otro rol.
      await api.delete<ApiMessageResponse>(
        `/api/notifications?targetRole=${encodeURIComponent(selectedRoleFilter)}`,
      );
      setNotifications((prev) => prev.filter((n) => !n.read));
    } catch (err) {
      console.error('Error limpiando notificaciones leídas:', err);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.delete<ApiMessageResponse>(`/api/notifications?id=${id}`);
      setNotifications((prev) => prev.filter((n) => n._id !== id));
    } catch (err) {
      console.error('Error eliminando notificación:', err);
    }
  };

  const handleOpenPreferences = () => {
    setShowDropdown(false);
    router.push('/settings/notifications');
  };

  const openDropdown = (position: 'first' | 'last' = 'first') => {
    pendingInitialFocusRef.current = position;
    setShowDropdown(true);
  };

  const handleBellKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openDropdown(event.key === 'ArrowUp' ? 'last' : 'first');
  };

  // Flechas, Home y End recorren las notificaciones; Escape se maneja global.
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isRovingKey(event.key)) return;

    // Dentro del selector de rol, las flechas deben cambiar la opción.
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea, [contenteditable="true"]')) return;

    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[data-notification-item="true"]') ?? [],
    );
    if (items.length === 0) return;

    event.preventDefault();
    const activeIndex =
      document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
    const nextIndex = getRovingIndex(activeIndex, items.length, event.key);
    if (nextIndex !== null) items[nextIndex].focus();
  };

  const unreadCount = notifications.filter((n) => !n.read).length;
  // El número visible forma parte del nombre accesible (WCAG 2.5.3): si no,
  // axe detecta label-content-name-mismatch en la campana.
  const unreadAccessibleLabel =
    notificationsEnabled && unreadCount > 0
      ? `, ${unreadCount > 99 ? '99+' : unreadCount} sin leer`
      : '';
  const bellActionLabel = showDropdown
    ? 'Cerrar bandeja de notificaciones'
    : 'Abrir bandeja de notificaciones';
  const bellAccessibleLabel = `${bellActionLabel}${unreadAccessibleLabel}`;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Botón de Campana */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (showDropdown ? closeDropdown() : openDropdown())}
        onKeyDown={handleBellKeyDown}
        className="relative flex h-11 w-11 items-center justify-center rounded-md border border-border bg-surface-muted text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:scale-95"
        title={notificationsEnabled ? 'Notificaciones' : 'Notificaciones desactivadas'}
        aria-label={bellAccessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={showDropdown}
        aria-controls={showDropdown ? panelId : undefined}
      >
        {notificationsEnabled ? (
          <Bell className="h-5 w-5" aria-hidden="true" />
        ) : (
          <BellOff className="h-5 w-5 opacity-60" aria-hidden="true" />
        )}
        {notificationsEnabled && unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 animate-pulse items-center justify-center rounded-full bg-status-blocked px-1.5 text-[10px] font-semibold text-white motion-reduce:animate-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Backdrop para móviles */}
      {showDropdown && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs transition-opacity sm:hidden"
          onClick={() => closeDropdown()}
          aria-hidden="true"
        />
      )}

      {/* Menú Desplegable / Bandeja de Notificaciones */}
      {showDropdown && (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-labelledby={panelTitleId}
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          className="fixed inset-x-3 top-20 z-50 flex max-h-[80vh] w-auto animate-pop-in flex-col overflow-hidden rounded-lg border border-border bg-surface text-foreground shadow-elevation-2 transition-all duration-200 focus:outline-none sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-3 sm:max-h-[550px] sm:w-[400px]"
        >
          {/* Cabecera */}
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface p-4">
            <div className="flex items-center gap-2.5">
              <div className="rounded-md bg-action-soft p-2 text-action-text">
                <Bell className="h-4 w-4" aria-hidden="true" />
              </div>
              <div>
                <h3 id={panelTitleId} className="text-sm font-semibold leading-tight">
                  Notificaciones
                </h3>
                <p className="text-[11px] text-subtle">
                  {!notificationsEnabled
                    ? 'Desactivadas en tus preferencias'
                    : unreadCount === 0
                      ? 'Estás al día'
                      : `${unreadCount} ${unreadCount === 1 ? 'nueva notificación' : 'nuevas notificaciones'}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`flex h-11 w-11 items-center justify-center rounded-md transition-colors ${
                  showSettings
                    ? 'bg-action text-action-fg'
                    : 'text-muted hover:bg-surface-muted hover:text-foreground'
                }`}
                title="Configurar filtros"
                aria-label={
                  showSettings
                    ? 'Ocultar filtros de notificaciones'
                    : 'Configurar filtros de notificaciones'
                }
                aria-expanded={showSettings}
                aria-controls={showSettings ? settingsPanelId : undefined}
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => closeDropdown()}
                className="flex h-11 w-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
                aria-label="Cerrar bandeja de notificaciones"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Panel de Configuración de Filtros */}
          {showSettings && (
            <div
              id={settingsPanelId}
              className="shrink-0 animate-slide-in-top space-y-2 border-b border-border bg-surface-muted p-3.5 text-xs"
            >
              {isVendor ? (
                <p className="text-[11px] text-muted">
                  Recibís alertas privadas de tus propios pedidos.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between font-medium">
                    <span className="text-foreground">Filtrar alertas por rol:</span>
                    <button
                      onClick={() => setShowSettings(false)}
                      className="text-[11px] font-medium text-action-text hover:underline"
                    >
                      Ocultar
                    </button>
                  </div>
                  <select
                    value={selectedRoleFilter}
                    onChange={(e) =>
                      setSelectedRoleFilter(e.target.value as NotificationTargetRole)
                    }
                    className="w-full rounded-md border border-border-strong bg-field px-3 py-2 text-xs font-medium text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30"
                  >
                    <option value="all">Todas las alertas (Global)</option>
                    <option value="deposit">Depósito (Nuevos Pedidos)</option>
                    <option value="billing">Facturación (Pedidos Listos)</option>
                  </select>
                </>
              )}
              <button
                onClick={handleOpenPreferences}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 py-2 font-semibold text-action-text transition-colors hover:bg-action-soft"
              >
                <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
                Preferencias de notificaciones
              </button>
            </div>
          )}

          {/* Listado de Notificaciones */}
          <div className="flex-1 divide-y divide-border overflow-y-auto overscroll-contain">
            {!notificationsEnabled ? (
              <div className="flex flex-col items-center justify-center space-y-3 px-6 py-14 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-surface-muted text-subtle">
                  <BellOff className="h-7 w-7" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Notificaciones desactivadas
                  </p>
                  <p className="mt-1 max-w-xs text-xs text-muted">
                    No se consultan alertas ni se muestra el contador. Podés volver a activarlas
                    desde tus preferencias.
                  </p>
                </div>
                <button
                  onClick={handleOpenPreferences}
                  className="rounded-md bg-action px-3 py-2 text-xs font-semibold text-action-fg transition-colors hover:bg-action-hover"
                >
                  Abrir preferencias
                </button>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center space-y-3 px-6 py-14 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-surface-muted text-subtle">
                  <Inbox className="h-7 w-7" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Bandeja vacía</p>
                  <p className="mt-1 text-xs text-muted">
                    No hay notificaciones registradas para este filtro.
                  </p>
                </div>
              </div>
            ) : (
              notifications.map((n) => {
                const date = new Date(n.createdAt);
                const timeStr = NOTIFICATION_TIME_FORMATTER.format(date);
                const dateStr = NOTIFICATION_DATE_FORMATTER.format(date);
                // Resuelto antes de renderizar para reflejar en el texto si el
                // destino es directo o hay que elegir bandeja.
                const orderHref = resolveOrderHref({
                  currentRole: routingRole,
                  targetRole: n.targetRole,
                  orderId: n.orderId,
                });

                return (
                  <div
                    key={n._id}
                    role="button"
                    tabIndex={0}
                    data-notification-item="true"
                    aria-label={`${n.title}. ${n.message}${n.read ? '' : '. Notificación sin leer'}`}
                    onClick={() => handleNotificationClick(n, orderHref)}
                    onKeyDown={(event) => {
                      // Ignora eventos de los botones anidados (borrar, elegir bandeja).
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      handleNotificationClick(n, orderHref);
                    }}
                    className={`cv-list-item cv-notification-item group relative flex cursor-pointer items-start gap-3 p-3.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:p-4 ${
                      n.read
                        ? 'bg-surface opacity-70 hover:bg-surface-muted'
                        : 'border-l-4 border-action bg-action-soft hover:bg-action-soft-hover'
                    }`}
                  >
                    <div
                      className={`mt-0.5 shrink-0 rounded-md p-2 ${
                        n.read ? 'bg-surface-muted text-subtle' : 'bg-action text-action-fg'
                      }`}
                    >
                      <Package className="h-4 w-4" aria-hidden="true" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <p
                          className={`truncate font-semibold ${n.read ? 'text-muted' : 'text-foreground'}`}
                        >
                          {n.title}
                        </p>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-[10px] font-medium text-subtle">
                            {dateStr} • {timeStr}
                          </span>
                          {n.read && (
                            <button
                              type="button"
                              onClick={(e) => handleDelete(n._id, e)}
                              className="rounded-md p-1 text-subtle opacity-0 transition hover:bg-status-blocked-soft hover:text-status-blocked focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100"
                              title="Borrar notificación leída"
                              aria-label="Borrar notificación"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="line-clamp-2 leading-relaxed text-muted">{n.message}</p>

                      {n.orderId && (
                        <div className="mt-2 flex items-center gap-1 text-[11px] font-semibold text-action-text group-hover:underline">
                          <span>
                            {orderHref ? 'Ver detalle de pedido' : 'Elegir bandeja de destino'}
                          </span>
                          <ChevronRight
                            className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                            aria-hidden="true"
                          />
                        </div>
                      )}

                      {n.orderId && !orderHref && choosingNotificationId === n._id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="mt-2 flex items-center gap-2 rounded-md bg-surface-muted p-1.5"
                        >
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
                            Abrir en:
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRoleChoice(n, 'deposit')}
                            className="rounded-md bg-status-delivered px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-95"
                          >
                            Depósito
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRoleChoice(n, 'billing')}
                            className="rounded-md bg-status-ready px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-95"
                          >
                            Facturación
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pie de bandeja */}
          {notificationsEnabled && notifications.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-muted p-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted">{unreadCount} sin leer</span>
                {hasMore && (
                  <button
                    type="button"
                    onClick={loadMoreNotifications}
                    disabled={loadingMore}
                    className="text-[11px] font-semibold text-action-text transition-colors hover:text-action-hover disabled:cursor-wait disabled:opacity-50"
                  >
                    {loadingMore ? 'Cargando…' : 'Cargar más'}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {notifications.some((n) => n.read) && (
                  <button
                    type="button"
                    onClick={handleClearRead}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-status-blocked transition-colors hover:bg-status-blocked-soft"
                    title="Borrar todas las notificaciones leídas"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Limpiar leídas</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleMarkAllAsRead}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-action-text transition-colors hover:bg-action-soft"
                >
                  <CheckCheck className="h-4 w-4" aria-hidden="true" />
                  <span>Marcar todas</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
