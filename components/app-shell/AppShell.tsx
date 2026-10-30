'use client';

import { useState, type ReactNode } from 'react';
import AppSidebar from '@/components/app-shell/AppSidebar';
import AppTopBar from '@/components/app-shell/AppTopBar';
import MobileNavSheet from '@/components/app-shell/MobileNavSheet';
import { cn } from '@/components/ui/cn';
import type { UserRole } from '@/lib/authz';

interface AppShellProps {
  role: UserRole;
  username: string;
  pageTitle: string;
  pageDescription?: string;
  /** Muestra el botón "Volver" en mobile (el menú sigue accesible al lado). */
  backLabel?: string;
  /** Destino explícito de "Volver"; sin él se conserva el historial del navegador. */
  backHref?: string;
  children: ReactNode;
  mainClassName?: string;
  maxWidth?: '6xl' | '7xl';
  /** Espacio inferior extra cuando la página tiene una barra de acción fija. */
  bottomClearance?: 'default' | 'extra';
}

/**
 * Shell de la aplicación: sidebar en desktop, top bar y menú móvil. El bottom
 * nav móvil sigue viviendo en el layout global.
 */
export default function AppShell({
  role,
  username,
  pageTitle,
  pageDescription,
  backLabel,
  backHref,
  children,
  mainClassName,
  maxWidth = '6xl',
  bottomClearance = 'default',
}: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <AppSidebar role={role} />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopBar
          pageTitle={pageTitle}
          pageDescription={pageDescription}
          backLabel={backLabel}
          backHref={backHref}
          role={role}
          username={username}
          onOpenMenu={() => setMenuOpen(true)}
        />

        <main
          className={cn(
            'flex-1 px-4 pt-4 sm:px-6 md:px-8',
            bottomClearance === 'extra'
              ? 'pb-[calc(10rem+env(safe-area-inset-bottom))] md:pb-8'
              : 'pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-8',
            mainClassName,
          )}
        >
          <div className={cn('mx-auto w-full', maxWidth === '7xl' ? 'max-w-7xl' : 'max-w-6xl')}>
            {children}
          </div>
        </main>
      </div>

      <MobileNavSheet open={menuOpen} onClose={() => setMenuOpen(false)} role={role} />
    </div>
  );
}
