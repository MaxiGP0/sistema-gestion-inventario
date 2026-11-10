'use client';

import { useRef, useState } from 'react';
import { Loader2, Trash2, X } from 'lucide-react';
import ProductThumbnail from '@/components/ProductThumbnail';
import Button from '@/components/ui/Button';
import QuantityStepper from '@/components/ui/QuantityStepper';
import { vibrateOnTap } from '@/lib/haptics';
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
  /** Ajustar el descuento manual de una línea sin salir del resumen. */
  onDiscountChange?: (productId: string, value: string) => void;
  /** Volver al descuento de la marca/general de la línea. */
  onDiscountClear?: (productId: string) => void;
  emptyMessage?: string;
  className?: string;
}

interface SelectedOrderItemRowProps {
  productId: string;
  quantity: number;
  product: OrderCatalogProduct;
  discount: number;
  manualDiscount?: number;
  onQuantityChange: (productId: string, value: string) => void;
  onQuantityDelta: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onDiscountChange?: (productId: string, value: string) => void;
  onDiscountClear?: (productId: string) => void;
}

/**
 * Línea editable del carrito. El descuento vigente se muestra como chip
 * compacto; si hay un ajuste manual (o el vendedor lo pide) se despliega el
 * input con su botón para restaurar el descuento de la marca/general.
 */
function SelectedOrderItemRow({
  productId,
  quantity,
  product,
  discount,
  manualDiscount,
  onQuantityChange,
  onQuantityDelta,
  onRemoveItem,
  onDiscountChange,
  onDiscountClear,
}: SelectedOrderItemRowProps) {
  const [discountEditing, setDiscountEditing] = useState(false);
  const discountInputRef = useRef<HTMLInputElement>(null);
  const hasOverride = manualDiscount !== undefined && !Number.isNaN(manualDiscount);
  const canEditDiscount = Boolean(onDiscountChange && onDiscountClear);
  const showDiscountInput = canEditDiscount && (discountEditing || hasOverride);

  const openDiscountInput = () => {
    if (!canEditDiscount) return;
    vibrateOnTap();
    setDiscountEditing(true);
    requestAnimationFrame(() => discountInputRef.current?.focus());
  };

  const handleDiscountClear = () => {
    if (!onDiscountClear) return;
    vibrateOnTap();
    setDiscountEditing(false);
    onDiscountClear(productId);
  };

  const handleRemove = () => {
    vibrateOnTap();
    onRemoveItem(productId);
  };

  const addUnits = (delta: number) => {
    vibrateOnTap();
    onQuantityDelta(productId, delta);
  };

  const lineSubtotal = product.price * quantity;
  const lineDiscount = (lineSubtotal * discount) / 100;

  return (
    <li
      data-testid="selected-order-item"
      data-product-id={productId}
      className="rounded-md border border-border bg-surface p-3"
    >
      <div className="flex items-start gap-2.5">
        <ProductThumbnail
          src={product.imageUrl}
          alt={product.name}
          size={40}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[11px] text-subtle">{product.code}</span>
          <p className="break-words text-xs font-semibold text-foreground">{product.name}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Unitario ${product.price.toFixed(2)}
            {hasOverride && <span> · Desc. {discount}%</span>}
          </p>
        </div>
        <Button
          tone="red"
          appearance="ghost"
          size="icon-sm"
          onClick={handleRemove}
          aria-label={`Quitar ${product.name} del pedido`}
          title="Quitar producto"
          className="shrink-0"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">Subtotal</span>
        <span className="text-xs font-semibold tabular-nums text-foreground">
          ${lineSubtotal.toFixed(2)}
        </span>
      </div>
      {discount > 0 && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>Descuento {discount}%</span>
          <span className="tabular-nums">-${lineDiscount.toFixed(2)}</span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {showDiscountInput ? (
          <div className="relative">
            <input
              ref={discountInputRef}
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={manualDiscount === undefined ? '' : String(manualDiscount)}
              onChange={(e) => onDiscountChange?.(productId, e.target.value)}
              onBlur={() => {
                // Sin override el campo se repliega al salir; con un valor
                // manual queda visible para poder corregirlo.
                if (!hasOverride) setDiscountEditing(false);
              }}
              placeholder={`${discount}`}
              aria-label={`Descuento de ${product.name}`}
              data-testid="selected-order-item-discount-input"
              title={
                hasOverride
                  ? `Personalizado para esta línea (sin ajuste aplicaría ${discount}%)`
                  : `Descuento vigente de la línea: ${discount}%. Escribí para personalizarlo.`
              }
              className={`h-11 w-32 rounded-md border bg-field pl-2 pr-11 text-center text-base font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm ${
                hasOverride ? 'border-action ring-1 ring-action/30' : 'border-border-strong'
              }`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleDiscountClear}
              title="Quitar ajuste manual y volver al descuento de la marca"
              aria-label={`Restaurar descuento de marca para ${product.name}`}
              className="absolute right-0 top-1/2 h-11 w-11 -translate-y-1/2"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={openDiscountInput}
            disabled={!canEditDiscount}
            aria-label={`Ajustar descuento de ${product.name}. Aplica ${discount}%`}
            data-testid="selected-order-item-discount-chip"
            className="font-semibold"
          >
            Desc. {discount}% · Ajustar
          </Button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <QuantityStepper
            value={quantity}
            onChange={(value) => onQuantityChange(productId, String(value))}
            min={0}
            max={99999}
            label={`Cantidad en el pedido de ${product.name}`}
            decreaseLabel={`Restar una unidad del pedido para ${product.name}`}
            increaseLabel={`Sumar una unidad del pedido para ${product.name}`}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => addUnits(6)}
            aria-label={`Sumar 6 unidades de ${product.name}`}
            className="font-semibold"
          >
            +6
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => addUnits(12)}
            aria-label={`Sumar 12 unidades de ${product.name}`}
            className="font-semibold"
          >
            +12
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Carrito editable compartido por el resumen móvil y el panel de escritorio.
 * Cada línea muestra miniatura, código, nombre, precio unitario, descuento
 * efectivo y subtotal, con controles de cantidad, ajuste de descuento y
 * eliminación. Si el borrador todavía está recuperando un producto, la línea
 * queda visible con una carga liviana.
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
  onDiscountChange,
  onDiscountClear,
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
                    onClick={() => {
                      vibrateOnTap();
                      onRemoveItem(productId);
                    }}
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
          const manualDiscount = itemDiscounts[productId];
          const discount = resolveItemDiscount(
            productId,
            brandId,
            itemDiscounts,
            brandDiscounts,
            generalDiscount,
          );

          return (
            <SelectedOrderItemRow
              key={productId}
              productId={productId}
              quantity={quantity}
              product={product}
              discount={discount}
              manualDiscount={manualDiscount}
              onQuantityChange={onQuantityChange}
              onQuantityDelta={onQuantityDelta}
              onRemoveItem={onRemoveItem}
              onDiscountChange={onDiscountChange}
              onDiscountClear={onDiscountClear}
            />
          );
        })}
      </ul>
    </div>
  );
}
