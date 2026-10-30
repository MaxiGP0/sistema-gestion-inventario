'use client';

/**
 * Contexto de usuario del cliente. La fuente de verdad es la sesión del
 * servidor (cookie httpOnly): el layout raíz la resuelve una vez y la pasa como
 * `initialUser`, así el primer render ya tiene usuario y no hay request de
 * arranque ni flash de "sin sesión".
 *
 * `refresh()` sigue disponible para login, cambios de preferencias y la
 * revalidación al volver a foco/visibilidad. Reemplaza al viejo `sgi_user`
 * guardado en localStorage.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, isNetworkError } from '@/lib/api-client';
import { countPendingOrderRequests } from '@/lib/offline-order-queue';
import { flushPendingOrders } from '@/lib/order-put-sync';
import { clearUserOfflineData, readOfflineOwner, writeOfflineOwner } from '@/lib/pwa-client';
import type { AuthUserDTO, LogoutResponse, SessionResponse } from '@/lib/types';

/** Usuario de la sesión compartido por toda la app. */
export type AuthUser = AuthUserDTO;

interface UserContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Vuelve a leer la sesión del servidor. */
  refresh: () => Promise<void>;
  /** Cierra la sesión en el servidor, limpia cachés del SW y el estado local. */
  logout: () => Promise<void>;
}

/**
 * Ventana mínima entre revalidaciones por foco/visibilidad. Evita que un
 * cambio de pestaña o un alt-tab dispare una request por cada evento.
 */
const REVALIDATE_MIN_INTERVAL_MS = 30_000;

const UserContext = createContext<UserContextValue | null>(null);

export function UserProvider({
  initialUser,
  children,
}: {
  /**
   * Usuario resuelto en el servidor (`getInitialSessionUserFast`). Cuando la
   * prop está presente no se consulta `/api/auth/session` al montar: el primer
   * render ya tiene la sesión y el borrador se restaura sin esperar. La
   * validación completa sigue en `/api/auth/session` al volver el foco.
   */
  initialUser?: AuthUser | null;
  children: ReactNode;
}) {
  const hasServerUser = initialUser !== undefined;
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [loading, setLoading] = useState(!hasServerUser);
  const lastRefreshAtRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<SessionResponse>('/api/auth/session', { cache: 'no-store' });
      setUser(data.user);
    } catch (error) {
      // Un 401 es el estado normal sin sesión; sólo se registran fallos de red.
      if (isNetworkError(error)) console.error('Error cargando la sesión:', error);
      setUser(null);
    } finally {
      lastRefreshAtRef.current = Date.now();
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // Antes de cerrar la sesión, intentar drenar la cola de pedidos
    // pendientes: el POST de logout borra la cookie y un reintento posterior
    // respondería 401. Si no hay red o quedan fallos, la cola se conserva para
    // no perder ventas; el indicador global la retoma en el próximo login del
    // mismo usuario.
    let clearPendingOrders = true;
    try {
      const pending = await countPendingOrderRequests();
      if (pending > 0) {
        if (typeof navigator === 'undefined' || navigator.onLine) {
          await flushPendingOrders();
        }
        clearPendingOrders = (await countPendingOrderRequests()) === 0;
      }
    } catch (error) {
      console.error('No se pudo preparar la cola offline para el logout:', error);
    }

    try {
      await api.post<LogoutResponse>('/api/auth/logout');
    } catch (error) {
      console.error('Error cerrando la sesión:', error);
    }

    setUser(null);
    // Si otro usuario inicia sesión en este dispositivo no debe ver el
    // catálogo cacheado, los borradores ni las escrituras del turno anterior.
    await clearUserOfflineData({ userId: user?.id, clearPendingOrders });
  }, [user]);

  useEffect(() => {
    // Con `initialUser` la sesión ya vino del servidor: no hay request inicial.
    if (!hasServerUser) void refresh();
  }, [hasServerUser, refresh]);

  useEffect(() => {
    if (!user) return;

    // Un login con otra identidad (por ejemplo, tras vencer la cookie) no debe
    // heredar cachés ni escrituras pendientes del usuario anterior. En un
    // logout normal el dueño ya se borró y la cola se conserva si no se pudo
    // sincronizar.
    const previousOwner = readOfflineOwner();
    if (previousOwner && previousOwner !== user.id) {
      void clearUserOfflineData({
        userId: previousOwner,
        clearPendingOrders: true,
      }).finally(() => writeOfflineOwner(user.id));
      return;
    }

    writeOfflineOwner(user.id);
  }, [user]);

  useEffect(() => {
    // Revalida al volver a la pestaña/ventana (por ejemplo, tras un cambio de
    // rol o una baja hecha desde otro equipo), con un mínimo entre intentos.
    lastRefreshAtRef.current = Date.now();

    const revalidate = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastRefreshAtRef.current < REVALIDATE_MIN_INTERVAL_MS) return;
      void refresh();
    };

    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);

    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ user, loading, refresh, logout }),
    [user, loading, refresh, logout],
  );

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser(): UserContextValue {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser debe usarse dentro de UserProvider');
  }

  return context;
}
