'use client';

import { useEffect, useState } from 'react';
import { Vibrate, VibrateOff } from 'lucide-react';
import Card from '@/components/ui/Card';
import {
  isHapticsEnabled,
  isHapticsSupported,
  setHapticsEnabled,
  vibrateOnTap,
} from '@/lib/haptics';

/**
 * Preferencia local de vibración. No se guarda en `User` porque depende del
 * dispositivo que usa el operario, no de la cuenta.
 */
export default function HapticsPreferenceCard() {
  const [enabled, setEnabled] = useState(true);
  const [supported, setSupported] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setEnabled(isHapticsEnabled());
    setSupported(isHapticsSupported());
    setReady(true);
  }, []);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    setHapticsEnabled(next);
    if (next) vibrateOnTap(12);
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${
              enabled && supported
                ? 'bg-action-soft text-action-text'
                : 'bg-surface-muted text-subtle'
            }`}
          >
            {enabled && supported ? (
              <Vibrate className="h-6 w-6" aria-hidden="true" />
            ) : (
              <VibrateOff className="h-6 w-6" aria-hidden="true" />
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Vibración al tocar</h2>
            <p className="mt-1 text-sm text-muted">
              Confirma con una vibración corta los toques en cantidades, atajos y control de líneas.
              Se desactiva solo si tu sistema pide movimiento reducido o si el navegador no admite
              la API.
            </p>
            {ready && !supported && (
              <p className="mt-2 text-xs text-status-draft" role="status">
                Este dispositivo no admite vibración.
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Vibración al tocar"
          disabled={!ready || !supported}
          onClick={toggle}
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
    </Card>
  );
}
