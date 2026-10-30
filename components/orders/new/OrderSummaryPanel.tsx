'use client';

import Button from '@/components/ui/Button';
import { DiscountBreakdown } from '@/components/orders/new/OrderDiscounts';
import SelectedOrderItemsList from '@/components/orders/new/SelectedOrderItemsList';
import type {
  DiscountBySource,
  DiscountMap,
  OrderCatalogProduct,
  QuantityMap,
} from '@/lib/order-catalog';

interface OrderSummaryPanelProps {
  subtotal: number;
  totalDiscount: number;
  finalTotal: number;
  discountBySource: DiscountBySource;
  quantities: QuantityMap;
  productCache: Record<string, OrderCatalogProduct>;
  itemDiscounts: DiscountMap;
  brandDiscounts: DiscountMap;
  generalDiscount: number;
  onQuantityChange: (productId: string, value: string) => void;
  onQuantityDelta: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  loading: boolean;
  onSubmit: () => void;
  submitLabel?: string;
}

/** Carrito editable, totales del borrador y acción de guardado del panel de escritorio. */
export default function OrderSummaryPanel({
  subtotal,
  totalDiscount,
  finalTotal,
  discountBySource,
  quantities,
  productCache,
  itemDiscounts,
  brandDiscounts,
  generalDiscount,
  onQuantityChange,
  onQuantityDelta,
  onRemoveItem,
  loading,
  onSubmit,
  submitLabel = 'Guardar Pedido (Borrador)',
}: OrderSummaryPanelProps) {
  return (
    <>
      <h3 className="mb-3 text-sm font-semibold text-foreground">Resumen del Pedido</h3>

      <SelectedOrderItemsList
        quantities={quantities}
        productCache={productCache}
        itemDiscounts={itemDiscounts}
        brandDiscounts={brandDiscounts}
        generalDiscount={generalDiscount}
        onQuantityChange={onQuantityChange}
        onQuantityDelta={onQuantityDelta}
        onRemoveItem={onRemoveItem}
        className="mb-4 max-h-80 overflow-y-auto overscroll-contain border-b border-border pb-4"
      />

      <div className="space-y-2 text-sm">
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
          <span className="tabular-nums">${finalTotal.toFixed(2)}</span>
        </div>
      </div>

      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={onSubmit}
        loading={loading}
        loadingLabel="Guardando..."
        className="mt-6"
      >
        {submitLabel}
      </Button>
    </>
  );
}
