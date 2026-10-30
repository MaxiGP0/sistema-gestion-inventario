import {
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Package,
  PlusCircle,
  Settings,
  ShieldCheck,
  UploadCloud,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { USER_ROLES, type UserRole } from '@/lib/authz';

export interface AppNavItem {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
  roles: readonly UserRole[];
}

export interface AppNavGroup {
  key: string;
  label: string;
  items: readonly AppNavItem[];
  /** Se renderiza al pie del sidebar. */
  footer?: boolean;
}

export const APP_NAV_GROUPS: readonly AppNavGroup[] = [
  {
    key: 'main',
    label: 'Navegación',
    items: [
      {
        key: 'panel',
        href: '/',
        label: 'Panel',
        icon: LayoutDashboard,
        roles: USER_ROLES,
      },
      {
        key: 'new-order',
        href: '/orders/new',
        label: 'Nuevo Pedido',
        icon: PlusCircle,
        roles: ['admin', 'vendedor'],
      },
      {
        key: 'orders',
        href: '/orders',
        label: 'Mis Pedidos',
        icon: ClipboardList,
        roles: ['admin', 'vendedor'],
      },
      {
        key: 'deposit',
        href: '/deposit/orders',
        label: 'Bandeja de Depósito',
        icon: ClipboardCheck,
        roles: ['admin', 'controlador'],
      },
      {
        key: 'billing',
        href: '/billing/orders',
        label: 'Bandeja de Facturación',
        icon: FileText,
        roles: ['admin', 'billing'],
      },
    ],
  },
  {
    key: 'catalogs',
    label: 'Catálogos',
    items: [
      {
        key: 'catalog',
        href: '/catalog',
        label: 'Catálogo',
        icon: BookOpen,
        roles: ['vendedor', 'controlador'],
      },
      {
        key: 'catalog-clients',
        href: '/catalog/clients',
        label: 'Clientes',
        icon: Users,
        roles: ['vendedor', 'controlador'],
      },
      {
        key: 'brands',
        href: '/backoffice/brands',
        label: 'Marcas',
        icon: UploadCloud,
        roles: ['admin'],
      },
      {
        key: 'clients',
        href: '/backoffice/clients',
        label: 'Clientes',
        icon: Users,
        roles: ['admin'],
      },
      {
        key: 'products',
        href: '/backoffice/products',
        label: 'Productos',
        icon: Package,
        roles: ['admin'],
      },
      {
        key: 'import',
        href: '/backoffice/import',
        label: 'Excel',
        icon: UploadCloud,
        roles: ['admin'],
      },
      {
        key: 'users',
        href: '/backoffice/users',
        label: 'Usuarios',
        icon: ShieldCheck,
        roles: ['admin'],
      },
    ],
  },
  {
    key: 'settings',
    label: 'Sistema',
    footer: true,
    items: [
      {
        key: 'settings',
        href: '/settings/notifications',
        label: 'Ajustes',
        icon: Settings,
        roles: USER_ROLES,
      },
    ],
  },
];

/** Grupos visibles para el rol, sin items vacíos. */
export function navGroupsForRole(role: UserRole): AppNavGroup[] {
  return APP_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.roles.includes(role)),
  })).filter((group) => group.items.length > 0);
}

/** Coincidencia de ruta para marcar el item activo, incluyendo detalles. */
export function isNavItemActive(item: AppNavItem, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  if (item.href === '/orders') {
    return (
      pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new')
    );
  }
  if (item.href === '/catalog') return pathname === '/catalog';
  if (item.href === '/catalog/clients') return pathname === '/catalog/clients';
  if (item.href === '/settings/notifications') return pathname.startsWith('/settings');
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Rol que espera la campana de notificaciones. */
export function notificationsRoleForRole(role: UserRole): 'deposit' | 'billing' | 'vendor' | 'all' {
  if (role === 'controlador') return 'deposit';
  if (role === 'billing') return 'billing';
  if (role === 'vendedor') return 'vendor';
  return 'all';
}
