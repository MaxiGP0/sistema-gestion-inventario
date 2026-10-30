'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileSpreadsheet, Package, ShieldCheck, Tags, Users } from 'lucide-react';
import { cn } from '@/components/ui/cn';

const BACKOFFICE_TABS = [
  {
    value: 'products',
    href: '/backoffice/products',
    label: 'Productos',
    icon: Package,
  },
  {
    value: 'clients',
    href: '/backoffice/clients',
    label: 'Clientes',
    icon: Users,
  },
  {
    value: 'brands',
    href: '/backoffice/brands',
    label: 'Marcas',
    icon: Tags,
  },
  {
    value: 'import',
    href: '/backoffice/import',
    label: 'Excel',
    icon: FileSpreadsheet,
  },
  {
    value: 'users',
    href: '/backoffice/users',
    label: 'Usuarios',
    icon: ShieldCheck,
  },
] as const;

/**
 * Pestañas de administración. Scrollean en horizontal dentro de su propio
 * contenedor para no ensanchar el documento en pantallas de 360 px.
 */
export default function BackofficeTabs() {
  const pathname = usePathname() ?? '';

  return (
    <nav
      aria-label="Módulos del backoffice"
      data-testid="backoffice-tabs"
      className="mb-6 flex w-full max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-surface-muted p-1"
    >
      {BACKOFFICE_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        return (
          <Link
            key={tab.value}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            data-testid={`backoffice-tab-${tab.value}`}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
              active ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
