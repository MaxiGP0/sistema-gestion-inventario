'use client';

import { Loader2, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import QuantityStepper from '@/components/ui/QuantityStepper';
import {
  getBrandId,
  getSelectedOrderLines,
  resolveItemDiscount,
  type DiscountMap,
  type OrderCatalogProduct,
  type QuantityMap,
} from '@/lib/order-catalog';

interface SelectedOrderItemsListProps {
  quantities: QuantityMap;
  productCache: Record<string, OrderCatalogProduct>;
  itemDiscounts: DiscountMap;
  brandDiscounts: DiscountMap;
  generalDiscount: number;
  onQuantityChange: (productId: string, value: string) => void;
  onQuantityDelta: (productId: string, delta: number) => void;
  /** Quitar la línea del carrito (cantidad = 0). */
  onRemoveItem: (productId: string) => void;
  emptyMessage?: string;
  className?: string;
}

/**
 * Carrito editable compartido por el resumen móvil y el panel de escritorio.
 * Cada línea muestra código, nombre, precio unitario, descuento efectivo y
 * subtotal, con controles de cantidad y eliminación. Si el borrador todavía
 * está recuperando un producto, la línea queda visible con una carga liviana.
 */
export default function SelectedOrderItemsList({
  quantities,
  productCache,
  itemDiscounts,
  brandDiscounts,
  generalDiscount,
  onQuantityChange,
  onQuantityDelta,
  onRemoveItem,
  emptyMessage = 'Todavía no hay productos cargados.',
  className = '',
}: SelectedOrderItemsListProps) {
  const lines = getSelectedOrderLines(quantities, productCache);
  const totalUnits = lines.reduce((total, line) => total + line.quantity, 0);

  if (lines.length === 0) {
    return <p className={`text-xs text-muted ${className}`}>{emptyMessage}</p>;
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-foreground">Productos del pedido</h4>
        <span
          data-testid="selected-order-items-count"
          className="rounded-full bg-action-soft px-2 py-0.5 text-[11px] font-semibold text-action-text"
        >
          {lines.length} ítems · {totalUnits} u.
        </span>
      </div>

      <ul aria-label="Productos seleccionados del pedido" className="space-y-2">
        {lines.map(({ productId, quantity, product }) => {
          if (!product) {
            return (
              <li
                key={productId}
                data-testid="selected-order-item"
                data-product-id={productId}
                className="rounded-md border border-border bg-surface p-3"
              >
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                  <span>Recuperando producto del borrador...</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-subtle">Cantidad: {quantity}</span>
                  <Button
                    tone="red"
                    appearance="ghost"
                    size="icon-sm"
                    onClick={() => onRemoveItem(productId)}
                    aria-label="Quitar producto del pedido"
                    title="Quitar producto"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          }

          const brandId = getBrandId(product.brandId);
          const discount = resolveItemDiscount(
            productId,
            brandId,
            itemDiscounts,
            brandDiscounts,
            generalDiscount,
          );
          const lineSubtotal = product.price * quantity;
          const lineDiscount = (lineSubtotal * discount) / 100;

          return (
            <li
              key={productId}
              data-testid="selected-order-item"
              data-product-id={productId}
              className="rounded-md border border-border bg-surface p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-[11px] text-subtle">{product.code}</span>
                  <p className="break-words text-xs font-semibold text-foreground">
                    {product.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    Unitario ${product.price.toFixed(2)} · Desc. {discount}%
                  </p>
                </div>
                <Button
                  tone="red"
                  appearance="ghost"
                  size="icon-sm"
                  onClick={() => onRemoveItem(productId)}
                  aria-label={`Quitar ${product.name} del pedido`}
                  title="Quitar producto"
                  className="shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">Subtotal</span>
                <span className="font-semibold tabular-nums text-foreground">
                  ${lineSubtotal.toFixed(2)}
                </span>
              </div>
              {discount > 0 && (
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
                  <span>Descuento {discount}%</span>
                  <span className="tabular-nums">-${lineDiscount.toFixed(2)}</span>
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <QuantityStepper
                  value={quantity}
                  onChange={(value) => onQuantityChange(productId, String(value))}
                  min={0}
                  max={99999}
                  label={`Cantidad en el pedido de ${product.name}`}
                  decreaseLabel={`Restar una unidad del pedido para ${product.name}`}
                  increaseLabel={`Sumar una unidad del pedido para ${product.name}`}
                />
                <div className="ml-auto flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onQuantityDelta(productId, 6)}
                    aria-label={`Sumar 6 unidades de ${product.name}`}
                    className="font-semibold"
                  >
                    +6
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onQuantityDelta(productId, 12)}
                    aria-label={`Sumar 12 unidades de ${product.name}`}
                    className="font-semibold"
                  >
                    +12
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
