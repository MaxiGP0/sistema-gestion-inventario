'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  getOfflineCatalogSyncProgress,
  subscribeOfflineCatalogSyncProgress,
  type OfflineCatalogSyncProgress as SyncProgress,
} from '@/lib/offline-catalog-sync';

interface OfflineCatalogSyncProgressProps {
  className?: string;
}

/**
 * Aviso compacto de sincronización en curso. Se puede montar siempre: no
 * renderiza nada si no hay un full/delta activo.
 */
export default function OfflineCatalogSyncProgress({ className }: OfflineCatalogSyncProgressProps) {
  const [progress, setProgress] = useState<SyncProgress | null>(() =>
    getOfflineCatalogSyncProgress(),
  );

  useEffect(() => subscribeOfflineCatalogSyncProgress(setProgress), []);

  if (!progress || progress.phase === 'done') return null;

  const percentage =
    progress.total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.loaded / progress.total) * 100)))
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-catalog-sync-progress"
      className={`flex items-center gap-2 rounded-lg border border-action/20 bg-action-soft px-3 py-2 text-[11px] font-medium text-action-text ${
        className ?? ''
      }`}
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <span>
        Actualizando catálogo…
        {percentage !== null ? ` ${percentage}%` : null}
      </span>
    </div>
  );
}
