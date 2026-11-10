'use client';

import { useEffect, useState } from 'react';
import { Download, Share2, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import {
  INSTALLED_DISPLAY_MODE_QUERIES,
  dismissInstall,
  getInstallBannerState,
  isInstallDismissed,
  isIosDevice,
  isStandaloneDisplayMode,
  promptInstall,
  type BeforeInstallPromptEvent,
} from '@/lib/install-app';

/**
 * Ofrece instalar la PWA desde el panel. El botón sólo aparece cuando el
 * navegador dispara `beforeinstallprompt`; en iOS/Safari, que no soporta ese
 * evento, se muestra la ruta manual del menú Compartir.
 *
 * El aviso se oculta definitivamente si la app ya está instalada, si el
 * usuario lo cierra (localStorage) o cuando `appinstalled` confirma la
 * instalación.
 */
export default function InstallAppButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [ios, setIos] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const matchMedia = window.matchMedia?.bind(window);
    const mediaLists = INSTALLED_DISPLAY_MODE_QUERIES.map((query) => window.matchMedia?.(query));

    setInstalled(isStandaloneDisplayMode(matchMedia, navigatorWithStandalone.standalone));
    setIos(isIosDevice(navigator.userAgent, navigator.maxTouchPoints));
    setDismissed(isInstallDismissed(window.localStorage));

    const handleDisplayModeChange = () => {
      if (isStandaloneDisplayMode(matchMedia, navigatorWithStandalone.standalone)) {
        setInstalled(true);
      }
    };

    for (const mediaList of mediaLists) {
      if (!mediaList) continue;
      if (typeof mediaList.addEventListener === 'function') {
        mediaList.addEventListener('change', handleDisplayModeChange);
      } else {
        mediaList.addListener(handleDisplayModeChange);
      }
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      for (const mediaList of mediaLists) {
        if (!mediaList) continue;
        if (typeof mediaList.removeEventListener === 'function') {
          mediaList.removeEventListener('change', handleDisplayModeChange);
        } else {
          mediaList.removeListener(handleDisplayModeChange);
        }
      }

      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const state = getInstallBannerState({
    installed,
    dismissed,
    hasPrompt: promptEvent !== null,
    ios,
  });

  if (state === 'hidden') return null;

  const handleInstall = async () => {
    if (!promptEvent || busy) return;

    setBusy(true);

    try {
      const outcome = await promptInstall(promptEvent);
      // El evento se consume aunque el usuario cancele: Chrome puede disparar
      // uno nuevo más adelante si vuelve a cumplir los criterios.
      setPromptEvent(null);
      if (outcome === 'accepted') setInstalled(true);
    } catch {
      setPromptEvent(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    dismissInstall(window.localStorage);
  };

  return (
    <div
      data-testid="install-app-banner"
      className="mb-4 flex flex-col gap-3 rounded-lg border border-action/30 bg-action-soft p-4 text-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-action-text ring-1 ring-border">
          {state === 'prompt' ? (
            <Download className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Share2 className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            Instalá el Sistema de Gestión de Inventario en tu dispositivo
          </p>
          {state === 'prompt' ? (
            <p className="mt-0.5 text-xs text-muted">
              Abrila como app, sin la barra del navegador y con acceso directo desde el inicio.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted">
              En iPhone o iPad: Compartir &gt; Agregar a pantalla de inicio.
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
        {state === 'prompt' && (
          <Button size="sm" onClick={handleInstall} disabled={busy}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Abriendo…' : 'Instalar app'}
          </Button>
        )}
        <Button
          tone="slate"
          appearance="ghost"
          size="icon-sm"
          onClick={handleDismiss}
          aria-label="Cerrar aviso de instalación"
          title="Cerrar aviso"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
