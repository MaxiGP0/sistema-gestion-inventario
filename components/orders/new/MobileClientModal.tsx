'use client';

import { useId, useRef } from 'react';
import { Building2, Check, Plus, Search, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import RecentClients from '@/components/orders/new/RecentClients';
import type { OrderCatalogClient } from '@/lib/order-catalog';

interface MobileClientModalProps {
  open: boolean;
  onClose: () => void;
  clients: OrderCatalogClient[];
  recentClients: OrderCatalogClient[];
  selectedClient: OrderCatalogClient | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelectClient: (client: OrderCatalogClient) => void;
  onCreateClient: () => void;
}

const clientLocation = (client: OrderCatalogClient): string =>
  `${client.address || 'Sin dirección'} ${
    client.localidad
      ? `(${client.localidad}${client.province ? `, ${client.province}` : ''})`
      : client.province
        ? `(${client.province})`
        : ''
  }`;

/**
 * Hoja superior para elegir cliente en móvil: el buscador queda a la vista por
 * encima del teclado. Atrapa el foco y cierra con Escape.
 */
export default function MobileClientModal({
  open,
  onClose,
  clients,
  recentClients,
  selectedClient,
  search,
  onSearchChange,
  onSelectClient,
  onCreateClient,
}: MobileClientModalProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const handleSelect = (client: OrderCatalogClient) => {
    onSelectClient(client);
    onClose();
  };

  const handleClearSearch = () => {
    onSearchChange('');
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      variant="sheet-top"
      initialFocusRef={searchRef}
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <h3 id={titleId} className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <Building2 className="h-5 w-5 shrink-0 text-action-text" aria-hidden="true" />
          <span>Seleccionar Cliente</span>
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={onCreateClient}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nuevo cliente
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Cerrar selección de cliente"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <RecentClients
        clients={recentClients}
        selectedClient={selectedClient}
        onSelectClient={handleSelect}
        compact
      />

      <div className="relative mb-4 shrink-0">
        <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-subtle">
          <Search className="h-4 w-4" aria-hidden="true" />
        </span>
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar por código, nombre o localidad..."
          aria-label="Buscar cliente"
          autoFocus
          className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-12 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30"
        />
        {search && (
          <button
            type="button"
            onClick={handleClearSearch}
            aria-label="Limpiar búsqueda de cliente"
            title="Limpiar búsqueda"
            className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
        {clients.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted">
            No se encontraron clientes.
            <Button
              type="button"
              variant="secondary"
              size="sm"
              fullWidth
              onClick={onCreateClient}
              className="mt-3"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Crear cliente nuevo
            </Button>
          </div>
        ) : (
          clients.map((client) => {
            const active = selectedClient?._id === client._id;

            return (
              <button
                key={`mob-client-${client._id}`}
                type="button"
                onClick={() => handleSelect(client)}
                className={`flex w-full cursor-pointer items-center justify-between rounded-md border p-3 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  active
                    ? 'border-action/60 bg-action-soft font-semibold text-action-text'
                    : 'border-border bg-surface-muted text-foreground hover:border-border-strong hover:bg-surface'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate">
                    <strong className="font-mono font-semibold text-action-text">
                      {client.code}
                    </strong>{' '}
                    - {client.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-subtle">
                    {clientLocation(client)}
                  </span>
                </span>
                {active ? (
                  <Check className="h-4 w-4 shrink-0 text-action-text" aria-hidden="true" />
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
