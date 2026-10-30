'use client';

import type { ComponentType } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Bell, Menu, Moon, Settings, Sun } from 'lucide-react';
import DashboardHeaderActions from '@/components/DashboardHeaderActions';
import Button from '@/components/ui/Button';
import { useDarkMode } from '@/hooks/useDarkMode';
import { USER_ROLE_LABELS, type UserRole } from '@/lib/authz';
import { notificationsRoleForRole } from '@/lib/app-navigation';

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

interface AppTopBarProps {
  pageTitle: string;
  pageDescription?: string;
  /** Si se define, muestra el botón para volver junto al menú móvil. */
  backLabel?: string;
  /** Destino explícito de "Volver"; sin él se conserva el historial. */
  backHref?: string;
  role: UserRole;
  username: string;
  onOpenMenu: () => void;
}

/** Barra superior del shell. En mobile concentra menú, título y acciones. */
export default function AppTopBar({
  pageTitle,
  pageDescription,
  backLabel,
  backHref,
  role,
  username,
  onOpenMenu,
}: AppTopBarProps) {
  const router = useRouter();
  const [darkMode, setDarkMode] = useDarkMode();
  const notificationsRole = notificationsRoleForRole(role);

  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {backLabel ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 md:hidden"
            onClick={() => (backHref ? router.push(backHref) : router.back())}
            aria-label={backLabel}
            title={backLabel}
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </Button>
        ) : null}

        {/* El menú móvil sigue disponible incluso en pantallas con "Volver". */}
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 md:hidden"
          onClick={onOpenMenu}
          aria-label="Abrir menú"
          title="Abrir menú"
          data-testid="app-topbar-menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>

        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-foreground">{pageTitle}</h1>
          {pageDescription ? (
            <p className="hidden truncate text-xs text-muted sm:block">{pageDescription}</p>
          ) : null}
        </div>
      </div>

      <div className="hidden items-center gap-3 md:flex">
        <Link
          href="/settings/notifications"
          className="rounded-md text-right transition-colors hover:text-action-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <p className="text-sm font-medium text-foreground">{username}</p>
          <p className="text-xs text-status-delivered">{USER_ROLE_LABELS[role]}</p>
        </Link>
        <DashboardHeaderActions notificationsRole={notificationsRole} />
      </div>

      <div className="flex items-center gap-1 md:hidden">
        <Link
          href="/settings/notifications"
          aria-label="Ajustes y cuenta"
          title="Ajustes y cuenta"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <Settings className="h-5 w-5" aria-hidden="true" />
        </Link>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setDarkMode(!darkMode)}
          aria-label="Cambiar tema"
          title="Cambiar tema"
        >
          <Sun className="hidden h-5 w-5 text-amber-500 dark:block" aria-hidden="true" />
          <Moon className="h-5 w-5 dark:hidden" aria-hidden="true" />
        </Button>
        <NotificationsBell currentRole={notificationsRole} />
      </div>
    </header>
  );
}
