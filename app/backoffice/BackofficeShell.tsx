'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AppShell from '@/components/app-shell/AppShell';
import type { UserRole } from '@/lib/authz';
import BackofficeTabs from './BackofficeTabs';

interface BackofficeShellProps {
  role: UserRole;
  username: string;
  children: ReactNode;
}

const PAGE_META: Record<string, { title: string; description: string }> = {
  '/backoffice/brands': {
    title: 'Marcas',
    description: 'Alta, edición y baja de marcas del catálogo.',
  },
  '/backoffice/clients': {
    title: 'Clientes',
    description: 'Datos comerciales, direcciones y descuentos.',
  },
  '/backoffice/products': {
    title: 'Productos',
    description: 'Catálogo, precios, imágenes y stock.',
  },
  '/backoffice/import': {
    title: 'Importador de Archivos Excel',
    description: 'Carga masiva de clientes y productos.',
  },
  '/backoffice/users': {
    title: 'Usuarios',
    description: 'Roles, altas y restablecimiento de accesos.',
  },
};

/** Marco de las pantallas de administración del catálogo. */
export default function BackofficeShell({ role, username, children }: BackofficeShellProps) {
  const pathname = usePathname() ?? '';
  const meta = PAGE_META[pathname] ?? {
    title: 'Catálogos',
    description: 'Administración del catálogo del Sistema de Gestión de Inventario.',
  };

  return (
    <AppShell
      role={role}
      username={username}
      pageTitle={meta.title}
      pageDescription={meta.description}
    >
      <BackofficeTabs />
      {children}
    </AppShell>
  );
}
