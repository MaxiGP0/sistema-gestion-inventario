'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import Button from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { BrandDiscountsPanel, GeneralDiscountRow } from '@/components/orders/new/OrderDiscounts';
import RepeatLastOrderPanel from '@/components/orders/new/RepeatLastOrderPanel';
import type { DiscountMap, OrderCatalogBrand, OrderCatalogClient } from '@/lib/order-catalog';
import type { OrderSummaryDTO } from '@/lib/types';

export interface SelectedClientDetailsProps {
  selectedClient: OrderCatalogClient;
  loadingLastOrder: boolean;
  lastOrder: OrderSummaryDTO | null;
  onRepeat: () => void;
  /** La edición de un borrador no necesita volver a cargar el último pedido. */
  allowRepeat?: boolean;
  generalDiscount: number;
  baselineGeneralDiscount: number;
  onGeneralDiscountChange: (value: string) => void;
  onRestoreGeneralDiscount: () => void;
  brands: OrderCatalogBrand[];
  brandDiscounts: DiscountMap;
  baselineBrands: DiscountMap;
  showBrandDiscountsPanel: boolean;
  onToggleBrandDiscounts: () => void;
  onBrandDiscountChange: (brandId: string, value: string) => void;
  onBrandDiscountClear: (brandId: string) => void;
  onClearAllBrandDiscounts: () => void;
  /** Sólo el panel de escritorio muestra nombre, código y acción "Cambiar". */
  onClearClient?: () => void;
  showCode?: boolean;
  className?: string;
}

/** Datos compartidos por los paneles de cliente (sin la ficha en sí). */
export type ClientDetailsStateProps = Omit<
  SelectedClientDetailsProps,
  'selectedClient' | 'className' | 'showCode' | 'onClearClient'
>;

/**
 * Ficha del cliente elegido: dirección, repetir último pedido y descuentos.
 * La comparten la tarjeta móvil y el panel lateral de escritorio.
 */
export default function SelectedClientDetails({
  selectedClient,
  loadingLastOrder,
  lastOrder,
  onRepeat,
  allowRepeat = true,
  generalDiscount,
  baselineGeneralDiscount,
  onGeneralDiscountChange,
  onRestoreGeneralDiscount,
  brands,
  brandDiscounts,
  baselineBrands,
  showBrandDiscountsPanel,
  onToggleBrandDiscounts,
  onBrandDiscountChange,
  onBrandDiscountClear,
  onClearAllBrandDiscounts,
  onClearClient,
  showCode = false,
  className,
}: SelectedClientDetailsProps) {
  const activeBrandOverrides = brands.filter(
    (brand) => brandDiscounts[brand._id] !== undefined,
  ).length;

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border border-border bg-surface-muted p-3 text-xs',
        className,
      )}
    >
      {onClearClient && (
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-foreground">{selectedClient.name}</p>
          <Button
            appearance="ghost"
            tone="red"
            size="sm"
            onClick={onClearClient}
            className="px-1 text-[11px]"
          >
            Cambiar
          </Button>
        </div>
      )}

      {showCode && (
        <p>
          <strong className="text-muted">Código:</strong> {selectedClient.code}
        </p>
      )}

      <p className={showCode ? undefined : 'text-muted'}>
        <strong className={showCode ? 'text-muted' : undefined}>Dirección:</strong>{' '}
        {selectedClient.address || 'N/A'}{' '}
        {selectedClient.localidad
          ? `- ${selectedClient.localidad}${selectedClient.province ? `, ${selectedClient.province}` : ''}`
          : selectedClient.province
            ? `- ${selectedClient.province}`
            : ''}
      </p>

      {allowRepeat && (
        <RepeatLastOrderPanel
          loading={loadingLastOrder}
          lastOrder={lastOrder}
          onRepeat={onRepeat}
        />
      )}

      <div className="border-t border-border pt-2">
        <GeneralDiscountRow
          key={selectedClient._id}
          value={generalDiscount}
          baseline={baselineGeneralDiscount}
          onChange={onGeneralDiscountChange}
          onRestore={onRestoreGeneralDiscount}
        />
      </div>

      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={onToggleBrandDiscounts}
          className="flex w-full items-center justify-between text-[11px] font-medium text-action-text hover:underline"
        >
          <span className="flex items-center gap-1.5">
            Descuentos por Marca
            {activeBrandOverrides > 0 && (
              <span className="rounded-full bg-action-soft px-1.5 py-px text-[9px] font-semibold text-action-text">
                {activeBrandOverrides}
              </span>
            )}
          </span>
          {showBrandDiscountsPanel ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
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
    </div>
  );
}
