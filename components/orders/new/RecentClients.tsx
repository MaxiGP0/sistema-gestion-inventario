'use client';

import { History } from 'lucide-react';
import type { OrderCatalogClient } from '@/lib/order-catalog';

interface RecentClientsProps {
  clients: OrderCatalogClient[];
  selectedClient: OrderCatalogClient | null;
  onSelectClient: (client: OrderCatalogClient) => void;
  /** Variante compacta para el modal móvil. */
  compact?: boolean;
}

/**
 * Clientes recientes/frecuentes del usuario (máximo 5, ver offline-catalog).
 * Se muestran arriba del buscador para resolver el caso más habitual sin
 * abrir el desplegable.
 */
export default function RecentClients({
  clients,
  selectedClient,
  onSelectClient,
  compact = false,
}: RecentClientsProps) {
  if (clients.length === 0) return null;

  return (
    <div className={compact ? 'mb-3' : 'mb-3'} data-testid="recent-clients">
      <p className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
        <History className="h-3 w-3" aria-hidden="true" /> Recientes
      </p>
      <div className="flex flex-wrap gap-1.5">
        {clients.map((client) => {
          const selected = selectedClient?._id === client._id;
          return (
            <button
              key={`recent-client-${client._id}`}
              type="button"
              onClick={() => onSelectClient(client)}
              title={`${client.code} - ${client.name}`}
              aria-pressed={selected}
              className={`max-w-full truncate rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                selected
                  ? 'border-action/60 bg-action-soft text-action-text'
                  : 'border-border bg-surface text-muted hover:border-border-strong hover:text-foreground'
              }`}
            >
              <span className="font-mono">{client.code}</span> · {client.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
