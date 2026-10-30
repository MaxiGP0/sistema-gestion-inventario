'use client';

import { memo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import ProductThumbnail from '@/components/ProductThumbnail';
import Button from '@/components/ui/Button';
import QuantityStepper from '@/components/ui/QuantityStepper';
import { cn } from '@/components/ui/cn';
import { TableCell, TableRow } from '@/components/ui/Table';
import {
  calculateLineSubtotal,
  resolveCardDiscount,
  type OrderCatalogProduct,
} from '@/lib/order-catalog';

export interface CatalogProductRowProps {
  product: OrderCatalogProduct;
  qty: string | number;
  disc: string | number;
  defaultDiscount: number;
  onQuantityChange: (productId: string, value: string) => void;
  onQuantityDelta: (productId: string, delta: number) => void;
  onDiscountChange: (productId: string, value: string) => void;
  onDiscountClear: (productId: string) => void;
}

const discountInputClasses =
  'h-9 w-16 rounded-md border bg-field px-2 text-center text-xs font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30';

/**
 * Fila memoizada de la tabla de escritorio.
 * Evita re-renderizar las 50+ filas del catálogo en cada tecla (solo cambia la fila editada).
 */
export const ProductRowDesktop = memo(function ProductRowDesktop({
  product: p,
  qty,
  disc,
  defaultDiscount,
  onQuantityChange,
  onDiscountChange,
  onDiscountClear,
}: CatalogProductRowProps) {
  const hasOverride = disc !== '';

  return (
    <TableRow hover className="cv-list-item cv-table-row">
      <TableCell align="center">
        <ProductThumbnail src={p.imageUrl} alt={p.name} size={40} className="mx-auto" />
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs text-muted">{p.code}</TableCell>
      <TableCell className="font-medium text-foreground">{p.name}</TableCell>
      <TableCell align="right" className="font-semibold tabular-nums text-foreground">
        ${p.price.toFixed(2)}
      </TableCell>
      <TableCell align="right" className="font-medium tabular-nums text-muted">
        ${(p.priceWithIva || p.price * 1.21).toFixed(2)}
      </TableCell>
      <TableCell align="center">
        <div className="relative inline-block">
          <input
            type="number"
            min="0"
            max="100"
            step="0.5"
            value={disc}
            onChange={(e) => onDiscountChange(p._id, e.target.value)}
            placeholder={`${defaultDiscount}%`}
            aria-label={`Descuento de ${p.name}`}
            title={
              hasOverride
                ? `Personalizado para este producto (sin ajuste aplicaría ${defaultDiscount}%)`
                : `Aplica ${defaultDiscount}% de la marca. Escribí para personalizar este producto.`
            }
            className={cn(
              discountInputClasses,
              hasOverride ? 'border-action ring-1 ring-action/30' : 'border-border-strong',
            )}
          />
          {hasOverride && (
            <button
              type="button"
              onClick={() => onDiscountClear(p._id)}
              title="Quitar ajuste manual y volver al descuento de la marca"
              aria-label={`Volver al descuento de la marca para ${p.name}`}
              className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-subtle transition-colors hover:text-status-blocked"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </TableCell>
      <TableCell align="center">
        <QuantityStepper
          value={Number(qty) || 0}
          onChange={(value) => onQuantityChange(p._id, String(value))}
          min={0}
          max={99999}
          label={`Cantidad en el catálogo de ${p.name}`}
          decreaseLabel={`Restar una unidad del catálogo para ${p.name}`}
          increaseLabel={`Sumar una unidad del catálogo para ${p.name}`}
          className="mx-auto"
        />
      </TableCell>
    </TableRow>
  );
});

/**
 * Tarjeta memoizada para la vista móvil del catálogo.
 *
 * El descuento vigente se muestra como chip compacto: el input numérico sólo
 * se despliega al pedir un ajuste manual (o si ya hay un override activo) para
 * que la tarjeta no cargue un teclado en cada producto.
 */
export const ProductCardMobile = memo(function ProductCardMobile({
  product: p,
  qty,
  disc,
  defaultDiscount,
  onQuantityChange,
  onQuantityDelta,
  onDiscountChange,
  onDiscountClear,
}: CatalogProductRowProps) {
  const hasOverride = disc !== '';
  const [discountEditing, setDiscountEditing] = useState(false);
  const discountInputRef = useRef<HTMLInputElement>(null);
  const showDiscountInput = hasOverride || discountEditing;

  const quantity = Number(qty) || 0;
  const inCart = quantity > 0;
  const effectiveDiscount = resolveCardDiscount(disc, defaultDiscount);
  const lineTotal = calculateLineSubtotal(p.price, quantity, effectiveDiscount);

  const openDiscountInput = () => {
    setDiscountEditing(true);
    // El input se monta en el siguiente render: enfocarlo evita abrir el
    // teclado con un toque extra.
    requestAnimationFrame(() => discountInputRef.current?.focus());
  };

  const handleDiscountClear = () => {
    setDiscountEditing(false);
    onDiscountClear(p._id);
  };

  return (
    <div
      className={cn(
        'cv-list-item cv-product-card rounded-lg border p-4 transition-colors',
        inCart ? 'border-action/60 bg-action-soft/25' : 'border-border bg-surface',
      )}
    >
      <div className="mb-3 flex items-start gap-3">
        <ProductThumbnail src={p.imageUrl} alt={p.name} size={48} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="font-mono text-xs text-subtle">{p.code}</span>
            <div className="text-right">
              <div className="text-xs font-semibold tabular-nums text-foreground">
                ${p.price.toFixed(2)}{' '}
                <span className="text-[10px] font-normal text-subtle">s/IVA</span>
              </div>
              <div className="text-xs font-medium tabular-nums text-muted">
                ${(p.priceWithIva || p.price * 1.21).toFixed(2)}{' '}
                <span className="text-[10px] font-normal text-subtle">c/IVA</span>
              </div>
            </div>
          </div>
          <h4 className="mt-1 truncate text-sm font-semibold text-foreground">{p.name}</h4>
        </div>
      </div>

      {inCart && (
        <div
          data-testid="catalog-in-cart-badge"
          className="mb-3 flex items-center rounded-md border border-action/30 bg-surface/80 px-2.5 py-1.5 text-[11px] font-semibold text-action-text"
        >
          En carrito: {quantity} u. · ${lineTotal.toFixed(2)}
        </div>
      )}

      <div className="space-y-3 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted">
            Desc. {hasOverride && <span className="text-action-text">· manual</span>}
          </span>
          {showDiscountInput ? (
            <div className="relative shrink-0">
              <input
                ref={discountInputRef}
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={disc}
                onChange={(e) => onDiscountChange(p._id, e.target.value)}
                onBlur={() => {
                  // Sin override el campo se repliega al salir; con un valor
                  // manual queda visible para poder corregirlo.
                  if (!hasOverride) setDiscountEditing(false);
                }}
                placeholder={`${defaultDiscount}%`}
                aria-label={`Descuento de ${p.name}`}
                data-testid="catalog-discount-input"
                title={
                  hasOverride
                    ? `Personalizado para este producto (sin ajuste aplicaría ${defaultDiscount}%)`
                    : `Aplica ${defaultDiscount}% de la marca. Tocá para personalizar este producto.`
                }
                className={cn(
                  discountInputClasses,
                  'h-11 w-32 pr-10 text-center',
                  hasOverride ? 'border-action ring-1 ring-action/30' : 'border-border-strong',
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleDiscountClear}
                title="Quitar ajuste manual y volver al descuento de la marca"
                aria-label={`Volver al descuento de la marca para ${p.name}`}
                className="absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={openDiscountInput}
              aria-label={`Ajustar descuento de ${p.name}. Aplica ${defaultDiscount}%`}
              data-testid="catalog-discount-chip"
              className="shrink-0"
            >
              Desc. {defaultDiscount}% · Ajustar
            </Button>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted">Cantidad</label>
          <div className="flex items-center gap-2">
            <QuantityStepper
              value={quantity}
              onChange={(value) => onQuantityChange(p._id, String(value))}
              min={0}
              max={99999}
              label={`Cantidad en el catálogo de ${p.name}`}
              decreaseLabel={`Restar una unidad del catálogo para ${p.name}`}
              increaseLabel={`Sumar una unidad del catálogo para ${p.name}`}
            />
            <div className="grid flex-1 grid-cols-2 gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onQuantityDelta(p._id, 6)}
                aria-label={`Sumar 6 unidades de ${p.name}`}
                className="h-11 font-semibold"
              >
                +6
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onQuantityDelta(p._id, 12)}
                aria-label={`Sumar 12 unidades de ${p.name}`}
                className="h-11 font-semibold"
              >
                +12
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
