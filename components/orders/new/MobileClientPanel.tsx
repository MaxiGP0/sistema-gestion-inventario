'use client';

import { useState } from 'react';
import { Building2, ChevronDown, ChevronUp, User } from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import SelectedClientDetails, {
  type ClientDetailsStateProps,
} from '@/components/orders/new/SelectedClientDetails';
import {
  formatInvoiceType,
  formatPaymentCondition,
  INVOICE_TYPES,
  INVOICE_TYPE_LABELS,
  PAYMENT_CONDITIONS,
  PAYMENT_CONDITION_LABELS,
  type InvoiceType,
  type PaymentCondition,
} from '@/lib/order-commercial';
import type { OrderCatalogClient } from '@/lib/order-catalog';

interface MobileClientPanelProps {
  selectedClient: OrderCatalogClient | null;
  onOpenClientModal: () => void;
  details: ClientDetailsStateProps;
  invoiceType: InvoiceType | '';
  onInvoiceTypeChange: (value: InvoiceType | '') => void;
  paymentCondition: PaymentCondition | '';
  onPaymentConditionChange: (value: PaymentCondition | '') => void;
  paymentConditionDetail: string;
  onPaymentConditionDetailChange: (value: string) => void;
  /** En la edición de un borrador el cliente no se puede cambiar. */
  lockClient?: boolean;
}

/**
 * Primera tarjeta del alta en móvil: cliente y datos comerciales.
 *
 * Con cliente, factura y pago ya definidos, los selects y descuentos se pliegan
 * en una tira de chips para que el catálogo quede a la vista; el vendedor los
 * vuelve a abrir con un toque cuando necesita ajustarlos.
 */
export default function MobileClientPanel({
  selectedClient,
  onOpenClientModal,
  details,
  invoiceType,
  onInvoiceTypeChange,
  paymentCondition,
  onPaymentConditionChange,
  paymentConditionDetail,
  onPaymentConditionDetailChange,
  lockClient = false,
}: MobileClientPanelProps) {
  const [commercialExpanded, setCommercialExpanded] = useState(false);
  const hasCommercialData = Boolean(selectedClient && invoiceType && paymentCondition);
  const showCommercialFields = !hasCommercialData || commercialExpanded;

  return (
    <Card padding="sm" className="lg:hidden">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <User className="h-4 w-4 text-action-text" aria-hidden="true" /> 1. Cliente y condiciones
      </h2>

      <div>
        <p className="mb-1 text-sm font-semibold text-foreground">
          Cliente <span className="text-status-blocked">*</span>
        </p>
        {lockClient && selectedClient ? (
          <div className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2.5 text-sm text-muted">
            <Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {selectedClient.code} - {selectedClient.name}
            </span>
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            fullWidth
            onClick={onOpenClientModal}
            className="justify-start gap-2 px-3 py-2.5 text-sm"
          >
            <Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {selectedClient
                ? `${selectedClient.code} - ${selectedClient.name}`
                : 'Seleccionar cliente...'}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
          </Button>
        )}
      </div>

      {hasCommercialData && (
        <div
          data-testid="mobile-commercial-summary"
          className="mt-3 flex flex-wrap items-center gap-1.5 rounded-md border border-action/30 bg-action-soft/40 px-2.5 py-2"
        >
          <span className="rounded-full border border-action/30 bg-surface px-2 py-0.5 text-[11px] font-semibold text-action-text">
            {formatInvoiceType(invoiceType)}
          </span>
          <span className="rounded-full border border-action/30 bg-surface px-2 py-0.5 text-[11px] font-semibold text-action-text">
            {formatPaymentCondition(paymentCondition, paymentConditionDetail)}
          </span>
          <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
            Desc. {details.generalDiscount}%
          </span>
          <button
            type="button"
            onClick={() => setCommercialExpanded((current) => !current)}
            aria-expanded={showCommercialFields}
            aria-controls={showCommercialFields ? 'mobile-commercial-fields' : undefined}
            className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-action-text transition-colors hover:bg-action-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
          >
            {commercialExpanded
              ? 'Ocultar condición / descuentos'
              : 'Editar condición / descuentos'}
            {commercialExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      )}

      {showCommercialFields && (
        <div id="mobile-commercial-fields">
          {selectedClient ? (
            <SelectedClientDetails selectedClient={selectedClient} className="mt-3" {...details} />
          ) : (
            <p className="mt-2 text-xs text-status-draft">
              Seleccioná un cliente para aplicar sus descuentos automáticos.
            </p>
          )}

          <div className="mt-4 space-y-4">
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
          </div>
        </div>
      )}
    </Card>
  );
}
