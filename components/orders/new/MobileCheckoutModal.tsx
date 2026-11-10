'use client';

import { useId } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, FileText, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import { controlClasses } from '@/components/ui/Field';
import Modal from '@/components/ui/Modal';
import type {
  DiscountBySource,
  DiscountMap,
  OrderCatalogBrand,
  OrderCatalogClient,
  OrderCatalogProduct,
  QuantityMap,
} from '@/lib/order-catalog';
import {
  BrandDiscountsPanel,
  DiscountBreakdown,
  GeneralDiscountRow,
} from '@/components/orders/new/OrderDiscounts';
import SelectedOrderItemsList from '@/components/orders/new/SelectedOrderItemsList';
import {
  INVOICE_TYPES,
  INVOICE_TYPE_LABELS,
  PAYMENT_CONDITIONS,
  PAYMENT_CONDITION_LABELS,
  type InvoiceType,
  type PaymentCondition,
} from '@/lib/order-commercial';

interface MobileCheckoutModalProps {
  open: boolean;
  onClose: () => void;
  salesperson: string;
  selectedClient: OrderCatalogClient | null;
  onChangeClient: () => void;
  comment: string;
  onCommentChange: (value: string) => void;
  invoiceType: InvoiceType | '';
  onInvoiceTypeChange: (value: InvoiceType | '') => void;
  paymentCondition: PaymentCondition | '';
  onPaymentConditionChange: (value: PaymentCondition | '') => void;
  paymentConditionDetail: string;
  onPaymentConditionDetailChange: (value: string) => void;
  brands: OrderCatalogBrand[];
  brandDiscounts: DiscountMap;
  baselineBrands: DiscountMap;
  generalDiscount: number;
  baselineGeneralDiscount: number;
  onGeneralDiscountChange: (value: string) => void;
  onRestoreGeneralDiscount: () => void;
  showBrandDiscountsPanel: boolean;
  onToggleBrandDiscounts: () => void;
  onBrandDiscountChange: (brandId: string, value: string) => void;
  onBrandDiscountClear: (brandId: string) => void;
  onClearAllBrandDiscounts: () => void;
  quantities: QuantityMap;
  productCache: Record<string, OrderCatalogProduct>;
  itemDiscounts: DiscountMap;
  onQuantityChange: (productId: string, value: string) => void;
  onQuantityDelta: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onDiscountChange: (productId: string, value: string) => void;
  onDiscountClear: (productId: string) => void;
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  discountBySource: DiscountBySource;
  totalItemsCount: number;
  distinctProductsCount: number;
  loading: boolean;
  onSubmit: () => Promise<void>;
  submitLabel?: string;
  /** En la edición de un borrador el cliente no se puede cambiar. */
  lockClient?: boolean;
}

/**
 * Hoja inferior con el resumen del pedido en móvil: vendedor, cliente,
 * descuentos, comentario y totales antes de guardar el borrador.
 */
export default function MobileCheckoutModal({
  open,
  onClose,
  salesperson,
  selectedClient,
  onChangeClient,
  comment,
  onCommentChange,
  invoiceType,
  onInvoiceTypeChange,
  paymentCondition,
  onPaymentConditionChange,
  paymentConditionDetail,
  onPaymentConditionDetailChange,
  brands,
  brandDiscounts,
  baselineBrands,
  generalDiscount,
  baselineGeneralDiscount,
  onGeneralDiscountChange,
  onRestoreGeneralDiscount,
  showBrandDiscountsPanel,
  onToggleBrandDiscounts,
  onBrandDiscountChange,
  onBrandDiscountClear,
  onClearAllBrandDiscounts,
  quantities,
  productCache,
  itemDiscounts,
  onQuantityChange,
  onQuantityDelta,
  onRemoveItem,
  onDiscountChange,
  onDiscountClear,
  subtotal,
  totalDiscount,
  finalTotal,
  discountBySource,
  totalItemsCount,
  distinctProductsCount,
  loading,
  onSubmit,
  submitLabel = 'Guardar Pedido (Borrador)',
  lockClient = false,
}: MobileCheckoutModalProps) {
  const titleId = useId();

  const activeBrandOverrides = brands.filter(
    (brand) => brandDiscounts[brand._id] !== undefined,
  ).length;

  const hasValidInvoiceType = invoiceType !== '';

  const hasValidPaymentCondition =
    paymentCondition !== '' &&
    (paymentCondition !== 'otro' || paymentConditionDetail.trim().length > 0);

  const handleSubmit = async () => {
    await onSubmit();
    // Mismo comportamiento que la página original: cerrar sólo si los datos
    // mínimos están completos (el resultado del POST se notifica con toast).
    if (
      selectedClient &&
      salesperson.trim() &&
      totalItemsCount > 0 &&
      hasValidInvoiceType &&
      hasValidPaymentCondition
    ) {
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} variant="sheet-bottom">
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
        <h3 id={titleId} className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <FileText className="h-5 w-5 shrink-0 text-action-text" aria-hidden="true" />
          <span className="truncate">Resumen y Guardar Pedido</span>
        </h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Cerrar resumen del pedido"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1 text-sm">
        <div className="space-y-2 rounded-md border border-border bg-surface-muted p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-muted">Vendedor:</span>
            <input
              type="text"
              value={salesperson}
              readOnly
              aria-readonly="true"
              aria-label="Vendedor de la sesión"
              className="h-9 w-40 cursor-default rounded-md border border-border-strong bg-field px-2 text-xs font-medium text-foreground"
            />
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="font-semibold text-muted">Cliente:</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex max-w-[150px] items-center gap-1 truncate font-medium text-action-text">
                {selectedClient ? (
                  `${selectedClient.code} - ${selectedClient.name}`
                ) : (
                  <>
                    <AlertTriangle
                      className="h-3.5 w-3.5 shrink-0 text-status-draft"
                      aria-hidden="true"
                    />
                    <span className="text-status-draft">Ninguno</span>
                  </>
                )}
              </span>
              {!lockClient && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onChangeClient();
                  }}
                  className="shrink-0 text-xs font-semibold text-action-text underline"
                >
                  Cambiar
                </button>
              )}
            </div>
          </div>
          {selectedClient && (
            <div className="border-t border-border pt-2">
              <GeneralDiscountRow
                key={selectedClient._id}
                value={generalDiscount}
                baseline={baselineGeneralDiscount}
                onChange={onGeneralDiscountChange}
                onRestore={onRestoreGeneralDiscount}
              />
            </div>
          )}
          {selectedClient && (
            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={onToggleBrandDiscounts}
                className="flex w-full items-center justify-between text-xs font-semibold text-action-text hover:underline"
              >
                <span className="flex items-center gap-1.5">
                  Descuentos por Marca
                  {activeBrandOverrides > 0 && (
                    <span className="rounded-full bg-action-soft px-1.5 py-px text-[11px] font-semibold text-action-text">
                      {activeBrandOverrides}
                    </span>
                  )}
                </span>
                {showBrandDiscountsPanel ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
              {showBrandDiscountsPanel && (
                <BrandDiscountsPanel
                  brands={brands}
                  brandDiscounts={brandDiscounts}
                  baselineBrands={baselineBrands}
                  generalDiscount={generalDiscount}
                  onBrandDiscountChange={onBrandDiscountChange}
                  onBrandDiscountClear={onBrandDiscountClear}
                  onClearAll={onClearAllBrandDiscounts}
                />
              )}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-semibold text-foreground">
            Tipo de Factura <span className="text-status-blocked">*</span>
          </label>
          <select
            aria-label="Tipo de factura"
            value={invoiceType}
            onChange={(e) => onInvoiceTypeChange(e.target.value as InvoiceType | '')}
            className={controlClasses}
          >
            <option value="">Seleccionar…</option>
            {INVOICE_TYPES.map((type) => (
              <option key={type} value={type}>
                {INVOICE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-semibold text-foreground">
            Condición de Pago <span className="text-status-blocked">*</span>
          </label>
          <select
            aria-label="Condición de pago"
            value={paymentCondition}
            onChange={(e) => onPaymentConditionChange(e.target.value as PaymentCondition | '')}
            className={controlClasses}
          >
            <option value="">Seleccionar…</option>
            {PAYMENT_CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {PAYMENT_CONDITION_LABELS[condition]}
              </option>
            ))}
          </select>

          {paymentCondition === 'otro' && (
            <div className="mt-3">
              <label className="mb-1 block text-sm font-semibold text-foreground">
                Detalle de la condición de pago <span className="text-status-blocked">*</span>
              </label>
              <input
                type="text"
                value={paymentConditionDetail}
                onChange={(e) => onPaymentConditionDetailChange(e.target.value)}
                maxLength={120}
                placeholder="Ej: cheque a 30 días"
                className={controlClasses}
              />
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-semibold text-foreground">
            Comentario / Observación (Opcional):
          </label>
          <textarea
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder="Observaciones..."
            rows={2}
            className={`${controlClasses} min-h-20 resize-none`}
          />
        </div>

        <div className="rounded-md border border-border bg-surface-muted p-3">
          <SelectedOrderItemsList
            quantities={quantities}
            productCache={productCache}
            itemDiscounts={itemDiscounts}
            brandDiscounts={brandDiscounts}
            generalDiscount={generalDiscount}
            onQuantityChange={onQuantityChange}
            onQuantityDelta={onQuantityDelta}
            onRemoveItem={onRemoveItem}
            onDiscountChange={onDiscountChange}
            onDiscountClear={onDiscountClear}
            className="max-h-72 overflow-y-auto overscroll-contain"
          />
        </div>

        <div className="space-y-2 rounded-md border border-border bg-surface-muted p-4">
          <div className="flex justify-between text-muted">
            <span>Productos seleccionados:</span>
            <span className="text-right font-semibold text-foreground">
              {totalItemsCount} unidades ({distinctProductsCount} ítems)
            </span>
          </div>
          <div className="flex justify-between text-muted">
            <span>Subtotal:</span>
            <span className="tabular-nums text-foreground">${subtotal.toFixed(2)}</span>
          </div>
          <DiscountBreakdown discountBySource={discountBySource} />
          <div className="flex justify-between text-muted">
            <span>Descuentos Totales:</span>
            <span className="tabular-nums text-foreground">-${totalDiscount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-foreground">
            <span>Total Final:</span>
            <span data-testid="mobile-checkout-final-total" className="tabular-nums">
              ${finalTotal.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Fuera del scroll: con el teclado abierto el guardado sigue visible. */}
      <div className="shrink-0 border-t border-border pt-4">
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleSubmit}
          loading={loading}
          loadingLabel="Guardando..."
          className="py-3.5"
        >
          {submitLabel}
        </Button>
      </div>
    </Modal>
  );
}
