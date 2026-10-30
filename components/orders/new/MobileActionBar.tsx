'use client';

import { Check, ShoppingCart } from 'lucide-react';
import Button from '@/components/ui/Button';

interface MobileActionBarProps {
  /** Hay cliente elegido en el pedido actual. */
  hasClient: boolean;
  /** Factura y condición de pago ya definidas. */
  hasInvoiceType: boolean;
  hasPaymentCondition: boolean;
  distinctProductsCount: number;
  finalTotal: number;
  /** Oculta la barra mientras el teclado virtual está abierto. */
  inputFocused: boolean;
  onOpenSummary: () => void;
}

/** Barra fija inferior de móvil: total, faltantes y acceso al resumen. */
export default function MobileActionBar({
  hasClient,
  hasInvoiceType,
  hasPaymentCondition,
  distinctProductsCount,
  finalTotal,
  inputFocused,
  onOpenSummary,
}: MobileActionBarProps) {
  const missingRequirement = !hasClient
    ? 'Falta elegir cliente'
    : !hasInvoiceType || !hasPaymentCondition
      ? 'Falta factura/pago'
      : distinctProductsCount === 0
        ? 'Falta agregar productos'
        : null;
  const isReady = missingRequirement === null;

  return (
    <div
      data-testid="mobile-order-action-bar"
      aria-hidden={inputFocused || undefined}
      inert={inputFocused || undefined}
      className={`fixed bottom-0 left-0 right-0 z-30 flex items-center justify-between gap-2 border-t border-border bg-surface/95 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-elevation-2 backdrop-blur-md transition-all duration-200 motion-reduce:transition-none lg:hidden ${
        inputFocused
          ? 'pointer-events-none translate-y-full opacity-0'
          : 'translate-y-0 opacity-100'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={onOpenSummary}
          data-testid="mobile-cart-button"
          aria-label={`Abrir resumen del pedido (${distinctProductsCount} productos)`}
          title="Abrir resumen del pedido"
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-action font-semibold text-action-fg shadow-elevation-1 transition active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <ShoppingCart className="h-5 w-5" aria-hidden="true" />
          {distinctProductsCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-status-draft-soft text-[10px] font-bold text-status-draft">
              {distinctProductsCount}
            </span>
          )}
        </button>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">Total Pedido</p>
          <p className="text-base font-semibold tabular-nums text-foreground">
            ${finalTotal.toFixed(2)}
          </p>
          {missingRequirement && (
            <p
              data-testid="mobile-action-hint"
              className="max-w-[9rem] text-[11px] font-medium leading-tight text-status-draft"
            >
              {missingRequirement}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isReady && (
          <span
            data-testid="mobile-action-ready"
            title="Datos obligatorios completos"
            className="inline-flex items-center gap-1 rounded-full border border-status-delivered-border bg-status-delivered-soft px-2 py-1 text-[11px] font-semibold text-status-delivered"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Listo
          </span>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={onOpenSummary}
          className="gap-1.5 px-4 py-2.5 text-xs font-semibold"
        >
          <span>Ver Resumen</span>
          <Check className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
