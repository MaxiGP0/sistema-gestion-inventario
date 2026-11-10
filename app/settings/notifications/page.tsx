'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff } from 'lucide-react';
import Card from '@/components/ui/Card';
import PushNotificationsCard from '@/components/PushNotificationsCard';
import HapticsPreferenceCard from '@/components/settings/HapticsPreferenceCard';
import OfflineCatalogCard from '@/components/settings/OfflineCatalogCard';
import { useUser } from '@/context/UserContext';
import { useToast } from '@/context/ToastContext';
import { api } from '@/lib/api-client';
import type { NotificationPreferenceResponse } from '@/lib/types';

/**
 * Preferencias personales de notificaciones. El valor vive en `User`
 * (`notificationsEnabled`) y se guarda con `PUT /api/users/notifications`,
 * que siempre opera sobre el usuario de la sesión.
 */
export default function NotificationPreferencesPage() {
  const { user, loading, refresh } = useUser();
  const { showToast } = useToast();
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (user) setEnabled(user.notificationsEnabled !== false);
  }, [user]);

  if (loading || !user) return null;

  const updatePreference = async (nextEnabled: boolean) => {
    const previous = enabled;
    setEnabled(nextEnabled);
    setSaving(true);

    try {
      const data = await api.put<NotificationPreferenceResponse>('/api/users/notifications', {
        notificationsEnabled: nextEnabled,
      });

      setEnabled(data.notificationsEnabled !== false);
      // Refresca el contexto global para que la campana reaccione en el acto.
      await refresh();
      showToast(data.message || 'Preferencia guardada', 'success');
    } catch (error: unknown) {
      setEnabled(previous);
      showToast((error as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-start gap-4">
            <div
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${
                enabled ? 'bg-action-soft text-action-text' : 'bg-surface-muted text-subtle'
              }`}
            >
              {enabled ? (
                <Bell className="h-6 w-6" aria-hidden="true" />
              ) : (
                <BellOff className="h-6 w-6" aria-hidden="true" />
              )}
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Alertas de pedidos</h2>
              <p className="mt-1 text-sm text-muted">
                Controla el contador de la campana y las actualizaciones en vivo de tu usuario. Al
                desactivarlas, las notificaciones se siguen generando para el resto del equipo, pero
                tu sesión no las consulta.
              </p>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Activar notificaciones"
            disabled={saving}
            onClick={() => void updatePreference(!enabled)}
            className="relative flex h-11 w-12 shrink-0 items-center justify-center disabled:opacity-60"
          >
            <span
              aria-hidden="true"
              className={`relative block h-6 w-12 rounded-full transition-colors ${
                enabled ? 'bg-action' : 'bg-border-strong'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </span>
          </button>
        </div>

        <div className="mt-5 flex items-center justify-between gap-4 rounded-lg bg-surface-muted px-4 py-3 text-sm">
          <span className="font-medium text-foreground">
            Estado actual:{' '}
            <span className={enabled ? 'text-status-delivered' : 'text-muted'}>
              {enabled ? 'Activadas' : 'Desactivadas'}
            </span>
          </span>
          {saving && <span className="text-xs text-muted">Guardando...</span>}
        </div>
      </Card>

      <PushNotificationsCard notificationsEnabled={enabled} />

      <HapticsPreferenceCard />

      <OfflineCatalogCard />
    </div>
  );
}
