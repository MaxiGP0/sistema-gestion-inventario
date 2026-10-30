'use client';

import { Database } from 'lucide-react';

interface OfflineCatalogBadgeProps {
  className?: string;
  /** Texto corto opcional para diferenciar clientes de productos. */
  detail?: string;
}

/**
 * Aviso de que la lista visible salió del snapshot de IndexedDB. Se muestra
 * cuando no hay red o cuando una consulta falló y se usó la copia local.
 */
export default function OfflineCatalogBadge({ className, detail }: OfflineCatalogBadgeProps) {
  return (
    <div
      role="status"
      data-testid="offline-catalog-badge"
      className={`flex items-center gap-2 rounded-lg border border-status-draft-border bg-status-draft-soft px-3 py-2 text-[11px] font-medium text-status-draft ${className ?? ''}`}
    >
      <Database className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Datos guardados; pueden estar desactualizados
        {detail ? <span className="opacity-80"> · {detail}</span> : null}
      </span>
    </div>
  );
}
