'use client';

import { AlertTriangle, Building2, Check, Plus } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input, { SearchInput } from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import RecentClients from '@/components/orders/new/RecentClients';
import SelectedClientDetails, {
  type ClientDetailsStateProps,
} from '@/components/orders/new/SelectedClientDetails';
import {
  INVOICE_TYPES,
  INVOICE_TYPE_LABELS,
  PAYMENT_CONDITIONS,
  PAYMENT_CONDITION_LABELS,
  type InvoiceType,
  type PaymentCondition,
} from '@/lib/order-commercial';
import type { OrderCatalogClient } from '@/lib/order-catalog';

interface ClientPanelProps {
  salesperson: string;
  clientSearch: string;
  onClientSearchChange: (value: string) => void;
  onClientSearchFocus: () => void;
  showClientDropdown: boolean;
  clients: OrderCatalogClient[];
  recentClients: OrderCatalogClient[];
  selectedClient: OrderCatalogClient | null;
  onSelectClient: (client: OrderCatalogClient) => void;
  onClearClient: () => void;
  onCreateClient: () => void;
  details: ClientDetailsStateProps;
  invoiceType: InvoiceType | '';
  onInvoiceTypeChange: (value: InvoiceType | '') => void;
  paymentCondition: PaymentCondition | '';
  onPaymentConditionChange: (value: PaymentCondition | '') => void;
  paymentConditionDetail: string;
  onPaymentConditionDetailChange: (value: string) => void;
  comment: string;
  onCommentChange: (value: string) => void;
  /** En la edición de un borrador el cliente no se puede cambiar. */
  lockClient?: boolean;
}

/**
 * Panel izquierdo de escritorio: vendedor, buscador de clientes, ficha con
 * descuentos y datos comerciales del pedido.
 */
export default function ClientPanel({
  salesperson,
  clientSearch,
  onClientSearchChange,
  onClientSearchFocus,
  showClientDropdown,
  clients,
  recentClients,
  selectedClient,
  onSelectClient,
  onClearClient,
  onCreateClient,
  details,
  invoiceType,
  onInvoiceTypeChange,
  paymentCondition,
  onPaymentConditionChange,
  paymentConditionDetail,
  onPaymentConditionDetailChange,
  comment,
  onCommentChange,
  lockClient = false,
}: ClientPanelProps) {
  return (
    <>
      <Input
        label="Vendedor"
        value={salesperson}
        disabled
        autoComplete="off"
        className="cursor-default"
      />

      <div className="mt-4 mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Building2 className="h-4 w-4 shrink-0 text-action-text" aria-hidden="true" />
          <span>1. Cliente</span>
        </h2>
        {!lockClient && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCreateClient}
            className="shrink-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nuevo cliente
          </Button>
        )}
      </div>

      {!lockClient && (
        <RecentClients
          clients={recentClients}
          selectedClient={selectedClient}
          onSelectClient={onSelectClient}
        />
      )}

      {!lockClient && (
        <div className="relative mb-4">
          <SearchInput
            label="Buscar cliente"
            value={clientSearch}
            onChange={(e) => onClientSearchChange(e.target.value)}
            onFocus={onClientSearchFocus}
            placeholder={
              selectedClient
                ? `${selectedClient.code} - ${selectedClient.name}`
                : 'Buscar cliente...'
            }
            autoComplete="off"
          />

          {showClientDropdown && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface shadow-elevation-2">
              {clients.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted">
                  No se encontraron clientes.
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onClick={onCreateClient}
                    className="mt-2"
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
                      key={client._id}
                      type="button"
                      onClick={() => onSelectClient(client)}
                      className={`flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2.5 text-left text-xs transition-colors last:border-b-0 hover:bg-surface-muted ${
                        active ? 'bg-action-soft text-action-text' : 'text-foreground'
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
                          {client.address || 'Sin dirección'}{' '}
                          {client.localidad
                            ? `(${client.localidad}${client.province ? `, ${client.province}` : ''})`
                            : client.province
                              ? `(${client.province})`
                              : ''}
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
          )}
        </div>
      )}

      {selectedClient ? (
        <SelectedClientDetails
          selectedClient={selectedClient}
          className="mb-6"
          showCode
          onClearClient={lockClient ? undefined : onClearClient}
          {...details}
        />
      ) : (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-status-draft-border bg-status-draft-soft p-3 text-xs text-status-draft">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Ningún cliente seleccionado</span>
        </div>
      )}

      <div className="space-y-4">
        <Select
          label="Tipo de factura"
          required
          value={invoiceType}
          onChange={(e) => onInvoiceTypeChange(e.target.value as InvoiceType | '')}
        >
          <option value="">Seleccionar…</option>
          {INVOICE_TYPES.map((type) => (
            <option key={type} value={type}>
              {INVOICE_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>

        <div>
          <Select
            label="Condición de pago"
            required
            value={paymentCondition}
            onChange={(e) => onPaymentConditionChange(e.target.value as PaymentCondition | '')}
          >
            <option value="">Seleccionar…</option>
            {PAYMENT_CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {PAYMENT_CONDITION_LABELS[condition]}
              </option>
            ))}
          </Select>

          {paymentCondition === 'otro' && (
            <Input
              label="Detalle de la condición de pago"
              required
              value={paymentConditionDetail}
              onChange={(e) => onPaymentConditionDetailChange(e.target.value)}
              maxLength={120}
              placeholder="Ej: cheque a 30 días"
              fieldClassName="mt-4"
            />
          )}
        </div>

        <Textarea
          label="Comentario"
          optional
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          placeholder="Agregar comentario u observación..."
          rows={2}
        />
      </div>
    </>
  );
}
