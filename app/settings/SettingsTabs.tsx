'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, ShieldCheck } from 'lucide-react';

const SETTINGS_TABS = [
  {
    href: '/settings/notifications',
    label: 'Notificaciones',
    icon: Bell,
    testId: 'settings-tab-notifications',
  },
  {
    href: '/settings/security',
    label: 'Seguridad / Contraseña',
    icon: ShieldCheck,
    testId: 'settings-tab-security',
  },
] as const;

/** Pestañas de Configuración, activas según la ruta actual. */
export default function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Secciones de configuración"
      className="flex gap-1 rounded-lg border border-border bg-surface p-1"
    >
      {SETTINGS_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            data-testid={tab.testId}
            className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-2 py-2 text-center text-sm font-medium transition-colors sm:px-3 ${
              active
                ? 'bg-action text-action-fg shadow-elevation-1'
                : 'text-muted hover:bg-surface-muted hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 leading-tight">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
