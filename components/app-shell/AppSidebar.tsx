'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import BrandWordmark from '@/components/BrandWordmark';
import { cn } from '@/components/ui/cn';
import type { UserRole } from '@/lib/authz';
import { isNavItemActive, navGroupsForRole } from '@/lib/app-navigation';

interface AppSidebarProps {
  role: UserRole;
}

/** Sidebar de escritorio con la navegación filtrada por rol. */
export default function AppSidebar({ role }: AppSidebarProps) {
  const pathname = usePathname() ?? '/';
  const groups = navGroupsForRole(role);
  const mainGroups = groups.filter((group) => !group.footer);
  const footerGroups = groups.filter((group) => group.footer);

  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href="/" className="inline-flex">
          <BrandWordmark className="h-9 w-auto" />
          <span className="sr-only">Ir al panel</span>
        </Link>
      </div>

      <nav
        aria-label="Navegación principal"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4"
      >
        <div className="flex flex-col gap-6">
          {mainGroups.map((group) => (
            <div key={group.key}>
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-subtle">
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
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
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

        {footerGroups.length > 0 ? (
          <div className="mt-auto space-y-1 border-t border-border pt-3">
            {footerGroups.map((group) =>
              group.items.map((item) => {
                const active = isNavItemActive(item, pathname);
                const Icon = item.icon;

                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                      active
                        ? 'bg-action-soft text-action-text'
                        : 'text-muted hover:bg-surface-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              }),
            )}
          </div>
        ) : null}

        <p className="mt-3 px-3 text-[11px] text-subtle">
          Por{' '}
          <a
            href="https://github.com/MaxiGP0"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            MaxiGP0
          </a>
        </p>
      </nav>
    </aside>
  );
}
