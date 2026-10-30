'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  BellOff,
  CheckCircle2,
  Info,
  Loader2,
  Send,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { useToast } from '@/context/ToastContext';
import { api, ApiClientError } from '@/lib/api-client';
import { PUSH_SUBSCRIPTION_MAX_PER_USER, type PushSubscriptionDTO } from '@/lib/push-subscriptions';
import {
  getCurrentPushSubscription,
  getPushCapability,
  getPushPermission,
  isFirefoxBrowser,
  isIosDevice,
  isPushSupported,
  subscribeCurrentDevice,
  toBrowserPushSubscriptionPayload,
  unsubscribeCurrentDevice,
} from '@/lib/push-client';
import type {
  PushSubscriptionDeleteResponse,
  PushSubscriptionListResponse,
  PushSubscriptionRegisterResponse,
  PushSubscriptionTestResponse,
} from '@/lib/types';

type DeviceStatus =
  | 'checking'
  | 'unsupported'
  | 'ios-install'
  | 'denied'
  | 'unconfigured'
  | 'idle'
  | 'subscribed'
  | 'error';

interface PushNotificationsCardProps {
  /** Preferencia personal; con `false` el backend tampoco envía push. */
  notificationsEnabled: boolean;
}

/**
 * Activación explícita de Web Push en el dispositivo actual.
 *
 * Nunca se pide permiso al cargar: el navegador solo lo permite desde una
 * acción del usuario y la pantalla se limita a leer el estado. El POST registra
 * el endpoint para el usuario de la sesión y el DELETE lo revoca.
 */
export default function PushNotificationsCard({
  notificationsEnabled,
}: PushNotificationsCardProps) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<DeviceStatus>('checking');
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionDTO[]>([]);
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [maxSubscriptions, setMaxSubscriptions] = useState(PUSH_SUBSCRIPTION_MAX_PER_USER);
  const [busy, setBusy] = useState(false);
  const [testingPush, setTestingPush] = useState(false);

  const loadSubscriptions = useCallback(async (): Promise<PushSubscriptionListResponse> => {
    const data = await api.get<PushSubscriptionListResponse>('/api/users/push-subscriptions', {
      cache: 'no-store',
    });

    setSubscriptions(data.subscriptions);
    setPublicKey(data.publicKey);
    setMaxSubscriptions(data.maxSubscriptions ?? PUSH_SUBSCRIPTION_MAX_PER_USER);
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const capability = getPushCapability();
      if (capability === 'ios-requires-install') {
        if (!cancelled) setStatus('ios-install');
        return;
      }

      if (capability === 'unsupported' || !isPushSupported()) {
        if (!cancelled) setStatus('unsupported');
        return;
      }

      if (getPushPermission() === 'denied') {
        if (!cancelled) setStatus('denied');
        return;
      }

      try {
        // Leer la lista no pide permiso ni crea una suscripción.
        const data = await loadSubscriptions();
        const subscription = await getCurrentPushSubscription();
        if (cancelled) return;

        const endpoint = subscription?.endpoint ?? null;
        setCurrentEndpoint(endpoint);

        if (!data.publicKey) {
          setStatus('unconfigured');
          return;
        }

        const registered = Boolean(
          endpoint && data.subscriptions.some((item) => item.endpoint === endpoint),
        );
        setStatus(registered ? 'subscribed' : 'idle');
      } catch {
        if (!cancelled) setStatus('error');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [loadSubscriptions]);

  const handleActivate = async () => {
    if (!notificationsEnabled) {
      showToast('Activá primero las alertas de pedidos para este usuario', 'error');
      return;
    }

    if (!isPushSupported()) {
      setStatus(getPushCapability() === 'ios-requires-install' ? 'ios-install' : 'unsupported');
      return;
    }

    setBusy(true);

    try {
      // Debe ejecutarse dentro del clic: Safari/iOS no acepta el pedido de
      // permiso si se hace después de esperar otra promesa.
      const permission =
        Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();

      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'idle');
        showToast('No se otorgó el permiso para mostrar notificaciones', 'error');
        return;
      }

      let key = publicKey;
      if (!key) {
        const data = await loadSubscriptions();
        key = data.publicKey;
      }

      if (!key) {
        setStatus('unconfigured');
        showToast('Web Push no está configurado en el servidor', 'error');
        return;
      }

      const subscription = await subscribeCurrentDevice(key);
      const payload = toBrowserPushSubscriptionPayload(subscription);

      const response = await api.post<PushSubscriptionRegisterResponse>(
        '/api/users/push-subscriptions',
        {
          ...payload,
          userAgent: navigator.userAgent.slice(0, 500),
        },
      );

      setCurrentEndpoint(payload.endpoint);
      setStatus('subscribed');
      await loadSubscriptions();
      showToast(response.message || 'Notificaciones push activadas en este dispositivo', 'success');
    } catch (error: unknown) {
      showToast(
        (error as Error).message || 'No se pudieron activar las notificaciones push',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);

    try {
      const endpointBefore = currentEndpoint;
      const unsubscribedEndpoint = await unsubscribeCurrentDevice();
      const endpoint = endpointBefore ?? unsubscribedEndpoint;

      if (endpoint) {
        const response = await api.delete<PushSubscriptionDeleteResponse>(
          `/api/users/push-subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
        );
        showToast(response.message || 'Suscripción push revocada', 'success');
      }

      setCurrentEndpoint(null);
      setStatus('idle');
      await loadSubscriptions();
    } catch (error: unknown) {
      showToast((error as Error).message || 'No se pudo revocar la suscripción push', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleTestPush = async () => {
    if (!notificationsEnabled) {
      showToast('Activá primero las alertas de pedidos para este usuario', 'error');
      return;
    }

    setTestingPush(true);

    try {
      const response = await api.patch<PushSubscriptionTestResponse>(
        '/api/users/push-subscriptions',
        currentEndpoint ? { endpoint: currentEndpoint } : {},
      );
      showToast(response.message || 'Notificación de prueba enviada a este dispositivo', 'success');
    } catch (error: unknown) {
      if (error instanceof ApiClientError && (error.status === 404 || error.status === 410)) {
        setCurrentEndpoint(null);
        setStatus('idle');
        void loadSubscriptions();
      }
      showToast((error as Error).message || 'No se pudo enviar la notificación de prueba', 'error');
    } finally {
      setTestingPush(false);
    }
  };

  const statusView = () => {
    switch (status) {
      case 'checking':
        return {
          icon: (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ),
          className: 'bg-surface-muted text-muted',
          text: 'Comprobando el estado de este dispositivo…',
        };
      case 'ios-install':
        return {
          icon: <Info className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-status-draft-soft text-status-draft',
          text: 'En iPhone/iPad las notificaciones push requieren iOS 16.4 o superior y la app instalada en la pantalla de inicio. Abrí Sistema de Gestión de Inventario desde el ícono instalado para activarlas.',
        };
      case 'unsupported':
        return {
          icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-status-draft-soft text-status-draft',
          text: 'Este navegador no soporta notificaciones push. Probá con Chrome, Edge o Safari actualizado.',
        };
      case 'denied':
        return {
          icon: <BellOff className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-status-blocked-soft text-status-blocked',
          text: 'El navegador tiene bloqueadas las notificaciones para este sitio. Habilitalas desde la configuración del sitio o del sistema y recargá la página.',
        };
      case 'unconfigured':
        return {
          icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-status-draft-soft text-status-draft',
          text: 'El servidor no tiene configuradas las claves VAPID. Un administrador debe definirlas para habilitar Web Push.',
        };
      case 'error':
        return {
          icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-status-blocked-soft text-status-blocked',
          text: 'No se pudo consultar el estado de las suscripciones. Recargá la página para reintentar.',
        };
      case 'subscribed':
        return {
          icon: <CheckCircle2 className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-status-delivered-soft text-status-delivered',
          text: 'Este dispositivo está suscripto: vas a recibir avisos con la app cerrada.',
        };
      default:
        return {
          icon: <BellRing className="h-4 w-4" aria-hidden="true" />,
          className: 'bg-surface-muted text-muted',
          text: 'Todavía no activaste las notificaciones push en este dispositivo.',
        };
    }
  };

  const view = statusView();
  const canActivate =
    notificationsEnabled && (status === 'idle' || status === 'error') && !testingPush;
  const canRevoke = status === 'subscribed' && !busy && !testingPush;
  const canTest = status === 'subscribed' && notificationsEnabled && !busy && !testingPush;

  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${
            status === 'subscribed'
              ? 'bg-status-delivered-soft text-status-delivered'
              : 'bg-surface-muted text-subtle'
          }`}
        >
          <Smartphone className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Notificaciones en este dispositivo
          </h2>
          <p className="mt-1 text-sm text-muted">
            Activalas para recibir avisos del sistema operativo, incluso con la app cerrada. El
            permiso del navegador se pide solamente cuando tocás el botón.
          </p>
        </div>
      </div>

      <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${view.className}`}>
        <span className="mt-0.5 shrink-0">{view.icon}</span>
        <span>{view.text}</span>
      </div>

      {!notificationsEnabled && (
        <div className="flex items-start gap-2 rounded-lg bg-status-draft-soft p-3 text-xs text-status-draft">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Tus alertas de pedidos están desactivadas. Aunque el dispositivo esté suscripto, el
            servidor no te enviará push hasta que vuelvas a activarlas con el interruptor de arriba.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={() => void handleActivate()}
          disabled={busy || !canActivate}
        >
          {busy && status !== 'subscribed' ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <BellRing className="h-4 w-4" aria-hidden="true" />
          )}
          Activar notificaciones en este dispositivo
        </Button>

        {status === 'subscribed' && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handleTestPush()}
            disabled={!canTest}
          >
            {testingPush ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            Probar en este dispositivo
          </Button>
        )}

        {canRevoke && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleRevoke()}
            disabled={busy}
          >
            {busy ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <BellOff className="h-4 w-4" aria-hidden="true" />
            )}
            Revocar en este dispositivo
          </Button>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-surface-muted p-3 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Dispositivos registrados en tu cuenta: <strong>{subscriptions.length}</strong> de{' '}
          <strong>{maxSubscriptions}</strong>. La suscripción se guarda solo para tu usuario; al
          revocarla, este navegador deja de recibir avisos.
        </span>
      </div>

      {isIosDevice() && (
        <div className="flex items-start gap-2 rounded-lg bg-action-soft p-3 text-xs text-action-text">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            En iPhone/iPad las notificaciones push no funcionan dentro de pestañas de Firefox ni de
            Safari: abrí Sistema de Gestión de Inventario en <strong>Safari</strong>, tocá{' '}
            <strong>Compartir → Agregar a pantalla de inicio</strong> y abrí la app desde ese ícono.
          </span>
        </div>
      )}

      {isFirefoxBrowser() && !isIosDevice() && (
        <div className="flex items-start gap-2 rounded-lg bg-action-soft p-3 text-xs text-action-text">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            En <strong>Firefox para Android</strong> verificá que no estés en navegación privada y
            que Firefox tenga permiso de notificaciones en{' '}
            <strong>Ajustes de Android → Aplicaciones → Firefox → Notificaciones</strong>.
          </span>
        </div>
      )}
    </Card>
  );
}
