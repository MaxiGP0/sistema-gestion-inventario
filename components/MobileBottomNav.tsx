'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  Boxes,
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
import { countSelectedItems } from '@/lib/order-catalog';
import { loadOrderDraft, ORDER_DRAFT_CHANGED_EVENT } from '@/lib/order-draft';

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

const backofficeItem: MobileNavItem = {
  key: 'backoffice',
  href: '/backoffice/products',
  label: 'Gestión',
  icon: Boxes,
  matches: (pathname) => pathname === '/backoffice' || pathname.startsWith('/backoffice/'),
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
  // Ajustes/Cuenta sigue siempre accesible desde el engranaje de AppTopBar.
  admin: [panelItem, newOrderItem, depositItem, billingItem, backofficeItem],
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

/** Productos distintos del borrador activo; 0 si el storage no está disponible. */
function readDraftItemCount(userId: string | null | undefined): number {
  if (!userId || typeof window === 'undefined') return 0;

  try {
    return countSelectedItems(loadOrderDraft(window.localStorage, userId)?.quantities ?? {})
      .distinct;
  } catch {
    return 0;
  }
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
  const userId = user?.id;
  const userRole = user?.role;
  const canTrackDraft = userRole === 'vendedor' || userRole === 'admin';
  const [draftCount, setDraftCount] = useState(0);

  // El borrador vive en localStorage y lo comparten el alta y el catálogo. Se
  // relee al navegar y ante el evento propio o un cambio desde otra pestaña.
  useEffect(() => {
    if (!canTrackDraft || !userId || !userRole || !shouldShowNav(pathname, userRole)) {
      setDraftCount(0);
      return;
    }

    const syncDraftCount = () => setDraftCount(readDraftItemCount(userId));

    syncDraftCount();
    window.addEventListener(ORDER_DRAFT_CHANGED_EVENT, syncDraftCount);
    window.addEventListener('storage', syncDraftCount);

    return () => {
      window.removeEventListener(ORDER_DRAFT_CHANGED_EVENT, syncDraftCount);
      window.removeEventListener('storage', syncDraftCount);
    };
  }, [canTrackDraft, pathname, userId, userRole]);

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
          const showDraftBadge = item.key === 'new' && draftCount > 0;

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
                <span className="relative flex h-5 w-5 items-center justify-center">
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {showDraftBadge && (
                    <span
                      data-testid="mobile-nav-draft-badge"
                      aria-label={`${draftCount} ${
                        draftCount === 1 ? 'ítem' : 'ítems'
                      } en el borrador`}
                      className="pointer-events-none absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-action px-1 text-[10px] font-bold leading-none text-action-fg tabular-nums"
                    >
                      {draftCount > 99 ? '99+' : draftCount}
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
