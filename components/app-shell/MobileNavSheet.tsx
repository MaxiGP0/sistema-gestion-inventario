'use client';

import { useId } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, X } from 'lucide-react';
import BrandWordmark from '@/components/BrandWordmark';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { cn } from '@/components/ui/cn';
import { useUser } from '@/context/UserContext';
import type { UserRole } from '@/lib/authz';
import { isNavItemActive, navGroupsForRole } from '@/lib/app-navigation';

interface MobileNavSheetProps {
  open: boolean;
  onClose: () => void;
  role: UserRole;
}

/** Menú móvil completo; el bottom nav sigue disponible en paralelo. */
export default function MobileNavSheet({ open, onClose, role }: MobileNavSheetProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { user, logout } = useUser();
  const titleId = useId();
  const groups = navGroupsForRole(role);

  const handleLogout = async () => {
    onClose();
    await logout();
    router.replace('/login');
    router.refresh();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      variant="sheet-top"
      className="max-h-[85dvh]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border pb-4">
        <Link href="/" onClick={onClose} className="inline-flex">
          <BrandWordmark className="h-8 w-auto" />
          <span className="sr-only">Ir al panel</span>
        </Link>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar menú">
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>

      <h2 id={titleId} className="sr-only">
        Menú de navegación
      </h2>

      <nav aria-label="Navegación móvil" className="min-h-0 flex-1 overflow-y-auto py-4">
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key}>
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                {group.label}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const active = isNavItemActive(item, pathname);
                  const Icon = item.icon;

                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                          active
                            ? 'bg-action-soft text-action-text'
                            : 'text-muted hover:bg-surface-muted hover:text-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="shrink-0 border-t border-border pt-4">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">Sesión</p>
        <p className="mt-1 truncate px-2 text-sm font-medium text-foreground">
          {user?.username ?? ''}
        </p>
        <Button variant="ghost" fullWidth onClick={handleLogout} className="mt-2 justify-start">
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Cerrar sesión
        </Button>
      </div>
    </Modal>
  );
}
