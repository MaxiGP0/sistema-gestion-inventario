'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  FileText,
  LayoutDashboard,
  PlusCircle,
  Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { useUser } from '@/context/UserContext';
import type { UserRole } from '@/lib/authz';

interface MobileNavItem {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
  /** Una ruta hija del ítem también lo marca como activo. */
  matches: (pathname: string) => boolean;
}

const panelItem: MobileNavItem = {
  key: 'panel',
  href: '/',
  label: 'Panel',
  icon: LayoutDashboard,
  matches: (pathname) => pathname === '/',
};

const newOrderItem: MobileNavItem = {
  key: 'new',
  href: '/orders/new',
  label: 'Nuevo',
  icon: PlusCircle,
  matches: (pathname) => pathname === '/orders/new',
};

const vendorOrdersItem: MobileNavItem = {
  key: 'orders',
  href: '/orders',
  label: 'Mis Pedidos',
  icon: ClipboardList,
  matches: (pathname) => pathname === '/orders',
};

const catalogItem: MobileNavItem = {
  key: 'catalog',
  href: '/catalog',
  label: 'Catálogo',
  icon: BookOpen,
  matches: (pathname) => pathname === '/catalog' || pathname.startsWith('/catalog/'),
};

const accountItem: MobileNavItem = {
  key: 'account',
  href: '/settings/notifications',
  label: 'Cuenta',
  icon: Settings,
  matches: (pathname) => pathname === '/settings' || pathname.startsWith('/settings/'),
};

const depositItem: MobileNavItem = {
  key: 'deposit',
  href: '/deposit/orders',
  label: 'Depósito',
  icon: ClipboardCheck,
  matches: (pathname) => pathname === '/deposit/orders',
};

const billingItem: MobileNavItem = {
  key: 'billing',
  href: '/billing/orders',
  label: 'Facturación',
  icon: FileText,
  matches: (pathname) => pathname === '/billing/orders',
};

/** Ítems exactos por rol, en el orden en que se muestran en la barra. */
const NAV_ITEMS_BY_ROLE: Record<UserRole, readonly MobileNavItem[]> = {
  vendedor: [panelItem, newOrderItem, vendorOrdersItem, catalogItem, accountItem],
  controlador: [panelItem, depositItem, catalogItem, accountItem],
  billing: [panelItem, billingItem, accountItem],
  admin: [panelItem, newOrderItem, depositItem, billingItem, accountItem],
};

/**
 * Rutas de listado/consulta con barra inferior propia. Las pantallas con
 * acciones fijas (alta, edición, picking, facturación y print) quedan fuera.
 */
const VISIBLE_PATHS = new Set([
  '/',
  '/orders',
  '/deposit/orders',
  '/billing/orders',
  '/catalog',
  '/catalog/clients',
]);

function normalizePathname(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '') || '/';
}

function shouldShowNav(pathname: string, role: UserRole): boolean {
  const isSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const isBackoffice = pathname === '/backoffice' || pathname.startsWith('/backoffice/');

  return VISIBLE_PATHS.has(pathname) || isSettings || (role === 'admin' && isBackoffice);
}

/**
 * Barra de navegación inferior de mobile. Mantiene a un toque el panel, el
 * alta, las bandejas del rol, el catálogo y la cuenta sin volver siempre al
 * Panel. En desktop no se renderiza (`md:hidden`).
 */
export default function MobileBottomNav() {
  const pathname = normalizePathname(usePathname() ?? '/');
  const { user } = useUser();

  if (!user || !shouldShowNav(pathname, user.role)) return null;

  const items = NAV_ITEMS_BY_ROLE[user.role];

  return (
    <nav
      aria-label="Navegación principal móvil"
      data-testid="mobile-bottom-nav"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-elevation-2 backdrop-blur-md md:hidden"
    >
      <ul className="mx-auto flex h-16 max-w-lg items-stretch justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.matches(pathname);

          return (
            <li key={item.key} className="flex min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                data-testid={`mobile-nav-${item.key}`}
                className={cn(
                  'relative flex h-full min-h-11 w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                  active ? 'text-action-text' : 'text-muted hover:text-foreground',
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-action"
                  />
                )}
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
