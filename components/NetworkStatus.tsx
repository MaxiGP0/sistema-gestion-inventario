'use client';

import React, { useState, useEffect, useRef } from 'react';
import { WifiOff, Wifi } from 'lucide-react';

/**
 * Aviso global de estado de red.
 *
 * Se renderiza dentro del flujo del documento (antes de las páginas), no como
 * banner `fixed`: así empuja el contenido hacia abajo y nunca tapa los botones
 * del AppTopBar (Volver / campana / tema) ni los controles de la página.
 * El `padding-top` respeta el notch y la barra de estado de las PWAs
 * instaladas.
 *
 * Los avisos contextuales de cada página (`OfflineSyncIndicator` abajo y
 * `OfflineCatalogBadge` dentro del contenido) quedan en otras zonas, sin
 * superponerse con esta barra.
 */
export default function NetworkStatus() {
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [showReconnected, setShowReconnected] = useState<boolean>(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    setIsOnline(navigator.onLine);

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const handleOnline = () => {
      setIsOnline(true);
      setShowReconnected(true);
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        setShowReconnected(false);
        reconnectTimerRef.current = null;
      }, 4000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setShowReconnected(false);
      clearReconnectTimer();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearReconnectTimer();
    };
  }, []);

  if (isOnline && !showReconnected) return null;

  const offline = !isOnline;

  return (
    <div
      data-testid="network-status"
      data-state={offline ? 'offline' : 'reconnected'}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`relative z-40 w-full border-b pt-[env(safe-area-inset-top)] text-xs font-medium transition-colors duration-300 sm:text-sm ${
        offline
          ? 'border-status-draft-border bg-status-draft-soft text-status-draft'
          : 'border-status-delivered-border bg-status-delivered-soft text-status-delivered'
      }`}
    >
      <div className="mx-auto flex min-h-10 w-full max-w-3xl items-center justify-center gap-2 px-3 py-1.5">
        {offline ? (
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Wifi className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 text-center">
          {offline ? 'Sin conexión · usando datos guardados' : 'Conexión restablecida'}
        </span>
      </div>
    </div>
  );
}
