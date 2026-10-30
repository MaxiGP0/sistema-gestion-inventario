'use client';

import { ShieldCheck, UserRound } from 'lucide-react';
import Card from '@/components/ui/Card';
import { useUser } from '@/context/UserContext';
import { USER_ROLE_LABELS } from '@/lib/authz';

/**
 * Resumen de la sesión actual. Se muestra en todas las pestañas de
 * Configuración para confirmar con qué usuario y rol se está operando.
 */
export default function SettingsAccountSummary() {
  const { user } = useUser();

  return (
    <Card padding="sm">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-action-soft text-action-text">
          <UserRound className="h-5 w-5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
            Sesión actual
          </h2>
          <p
            data-testid="settings-current-user"
            className="truncate text-sm font-semibold text-foreground"
          >
            {user?.username ?? 'Cargando usuario…'}
          </p>
          <p
            data-testid="settings-current-role"
            className="mt-0.5 flex items-center gap-1 text-xs text-status-delivered"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {user ? USER_ROLE_LABELS[user.role] : '—'}
          </p>
        </div>
      </div>
    </Card>
  );
}
