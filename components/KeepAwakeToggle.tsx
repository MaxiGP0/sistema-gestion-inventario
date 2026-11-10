'use client';

import { useEffect, useState } from 'react';
import { Monitor, Sun } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useWakeLock, useWakeLockPreference } from '@/hooks/useWakeLock';

interface KeepAwakeToggleProps {
  className?: string;
}

/**
 * Modo manos libres: mantiene la pantalla encendida mientras el operario
 * controla o carga un pedido. Es opcional y recuerda la preferencia local.
 */
export default function KeepAwakeToggle({ className }: KeepAwakeToggleProps) {
  const [enabled, setEnabled] = useWakeLockPreference();
  const [ready, setReady] = useState(false);
  const { supported, active, error } = useWakeLock(enabled);

  useEffect(() => {
    setReady(true);
  }, []);

  const unavailable = ready && !supported;

  return (
    <div className={`flex min-w-0 flex-col items-end gap-1 ${className ?? ''}`}>
      <Button
        type="button"
        variant={enabled ? 'primary' : 'secondary'}
        size="sm"
        aria-pressed={enabled}
        aria-label="Pantalla encendida"
        title="Mantener la pantalla encendida mientras trabajás"
        disabled={unavailable}
        onClick={() => setEnabled(!enabled)}
        data-testid="keep-awake-toggle"
        className="shrink-0 px-2.5 max-sm:min-h-11 max-sm:min-w-11"
      >
        {active ? (
          <Sun className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Monitor className="h-4 w-4" aria-hidden="true" />
        )}
        <span className="whitespace-nowrap">Pantalla encendida</span>
      </Button>

      {unavailable && (
        <p
          className="max-w-56 text-right text-[10px] leading-tight text-muted"
          role="status"
          data-testid="keep-awake-unsupported"
        >
          Este navegador no permite mantener la pantalla encendida
        </p>
      )}

      {!unavailable && error && (
        <p
          className="max-w-56 text-right text-[10px] leading-tight text-status-draft"
          role="status"
        >
          {error}
        </p>
      )}
    </div>
  );
}
