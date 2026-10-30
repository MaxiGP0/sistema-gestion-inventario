'use client';

import { useEffect, useTransition, type ComponentType } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, LogOut, Moon, Settings, Sun } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useDarkMode } from '@/hooks/useDarkMode';
import { useUser } from '@/context/UserContext';
import {
  orderNotificationMatchesTray,
  subscribeToOrderNotifications,
} from '@/lib/order-notification-events';
import { createRefreshScheduler, shouldRefreshAfterVisibility } from '@/lib/order-live-sync';

const NotificationsBell = dynamic(
  () =>
    import('@/components/NotificationsBell').catch(() => ({
      default: () => null,
    })),
  {
    ssr: false,
    loading: () => (
      <span
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-surface-muted text-subtle"
        aria-hidden="true"
      >
        <Bell className="h-5 w-5" />
      </span>
    ),
  },
) as ComponentType<{ currentRole?: 'deposit' | 'billing' | 'vendor' | 'all' }>;

interface DashboardHeaderActionsProps {
  notificationsRole: 'deposit' | 'billing' | 'vendor' | 'all';
}

/**
 * Único componente cliente del panel: tema, campana y cierre de sesión.
 * El resto del dashboard (KPIs, colas, accesos y últimos pedidos) se renderiza
 * en el servidor y llega listo en el HTML.
 */
export default function DashboardHeaderActions({ notificationsRole }: DashboardHeaderActionsProps) {
  const [darkMode, setDarkMode] = useDarkMode();
  const router = useRouter();
  const { logout } = useUser();
  const [, startTransition] = useTransition();

  // El panel es un Server Component: al llegar una alerta de este rol se
  // revalida el RSC en segundo plano (sin spinner) para actualizar KPIs, colas
  // y últimos pedidos. Las ráfagas se agrupan cada 1,5 s.
  useEffect(() => {
    let hiddenAt: number | null =
      typeof document !== 'undefined' && document.hidden ? Date.now() : null;

    const scheduler = createRefreshScheduler({
      onRefresh: () => {
        if (typeof document !== 'undefined' && document.hidden) return;
        startTransition(() => router.refresh());
      },
    });

    const unsubscribe = subscribeToOrderNotifications((detail) => {
      if (!orderNotificationMatchesTray(notificationsRole, detail.targetRole)) return;
      if (typeof document !== 'undefined' && document.hidden) return;

      scheduler.request();
    });

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;

      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }

      const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;

      // Pestañas ocultas por mucho tiempo pueden tener datos vencidos: se
      // aprovecha el regreso para revalidar, también con el throttle general.
      if (shouldRefreshAfterVisibility(hiddenFor)) scheduler.request();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      scheduler.cancel();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [notificationsRole, router]);

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className="flex items-center gap-1.5 sm:gap-3">
      <NotificationsBell currentRole={notificationsRole} />

      <Link
        href="/settings/notifications"
        aria-label="Ajustes y cuenta"
        title="Ajustes y cuenta"
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-border-strong bg-surface p-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <Settings className="h-5 w-5" aria-hidden="true" />
        <span className="hidden sm:inline">Ajustes</span>
      </Link>

      <Button
        tone="slate"
        appearance="outline"
        size="icon"
        onClick={() => setDarkMode(!darkMode)}
        title="Cambiar tema"
        aria-label="Cambiar tema"
      >
        <Sun className="hidden h-5 w-5 text-amber-500 dark:block" aria-hidden="true" />
        <Moon className="h-5 w-5 dark:hidden" aria-hidden="true" />
      </Button>

      <Button
        tone="slate"
        appearance="outline"
        size="icon"
        onClick={handleLogout}
        title="Cerrar Sesión"
        aria-label="Cerrar sesión"
      >
        <LogOut className="h-5 w-5" />
      </Button>
    </div>
  );
}
