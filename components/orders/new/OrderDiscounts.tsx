'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  formatGeneralDiscountInput,
  parseGeneralDiscount,
  type DiscountBySource,
  type DiscountMap,
  type OrderCatalogBrand,
} from '@/lib/order-catalog';

/**
 * Badge que indica el origen de un descuento por marca:
 * "Cliente" = configurado en la ficha del cliente, "Manual" = ajustado en este pedido.
 */
export function SourceBadge({
  source,
  baselineValue,
}: {
  source: 'client' | 'manual';
  baselineValue?: number;
}) {
  const isFromClient = source === 'client';
  const title = isFromClient
    ? `Configurado en la ficha del cliente (${baselineValue}%)`
    : baselineValue !== undefined
      ? `Ajustado manualmente en este pedido (el cliente tiene ${baselineValue}%)`
      : 'Ajustado manualmente en este pedido';

  return (
    <span
      title={title}
      className={`shrink-0 rounded px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide ${
        isFromClient ? 'bg-action-soft text-action-text' : 'bg-surface-muted text-muted'
      }`}
    >
      {isFromClient ? 'Cliente' : 'Manual'}
    </span>
  );
}

export interface GeneralDiscountRowProps {
  value: number;
  baseline: number;
  onChange: (value: string) => void;
  onRestore: () => void;
}

/**
 * Descuento general del pedido. Si se modificó el valor configurado en la ficha
 * del cliente, muestra el original y permite restaurarlo.
 */
export function GeneralDiscountRow({
  value,
  baseline,
  onChange,
  onRestore,
}: GeneralDiscountRowProps) {
  const isEdited = value !== baseline;
  // El estado numérico sigue viviendo en la página (totales, POST y draft).
  // El string es sólo presentación para poder mostrar 0 como placeholder y
  // evitar que el input controlado anteponga un "0" al escribir.
  const [inputValue, setInputValue] = useState(() => formatGeneralDiscountInput(value));
  const lastValueRef = useRef(value);

  // Sincroniza cambios externos (seleccionar/restaurar/borrador) sin pisar lo
  // que el usuario está escribiendo. Los cambios propios ya actualizaron la ref.
  useEffect(() => {
    if (lastValueRef.current === value) return;
    lastValueRef.current = value;
    setInputValue(formatGeneralDiscountInput(value));
  }, [value]);

  const handleInputChange = (rawValue: string) => {
    lastValueRef.current = parseGeneralDiscount(rawValue);
    setInputValue(rawValue);
    onChange(rawValue);
  };

  // Al salir del campo se normaliza la presentación (por ejemplo "0" -> vacío
  // y valores fuera de rango al efectivo), sin tocar el valor numérico.
  const handleInputBlur = () => {
    const normalized = parseGeneralDiscount(inputValue);
    lastValueRef.current = normalized;
    setInputValue(formatGeneralDiscountInput(normalized));
  };

  const handleRestore = () => {
    // Aunque el valor efectivo ya sea igual al baseline, el texto debe volver
    // al estado canónico (vacío si el cliente tiene 0%).
    lastValueRef.current = baseline;
    setInputValue(formatGeneralDiscountInput(baseline));
    onRestore();
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted">Desc. General (%):</span>
        <input
          type="number"
          min="0"
          max="100"
          step="0.5"
          value={inputValue}
          placeholder="0"
          onChange={(e) => handleInputChange(e.target.value)}
          onBlur={handleInputBlur}
          aria-label="Descuento general"
          title="Se aplica a las marcas sin descuento propio"
          className={`h-9 w-16 rounded-md border bg-field px-2 text-center text-sm font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30 ${
            isEdited ? 'border-action ring-1 ring-action/30' : 'border-border-strong'
          }`}
        />
      </div>
      {isEdited && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-xs text-subtle">Valor del cliente: {baseline}%</span>
          <button
            type="button"
            onClick={handleRestore}
            className="shrink-0 text-xs font-semibold text-action-text underline"
          >
            Restaurar
          </button>
        </div>
      )}
    </div>
  );
}

export interface BrandDiscountsPanelProps {
  brands: OrderCatalogBrand[];
  brandDiscounts: DiscountMap;
  baselineBrands: DiscountMap;
  generalDiscount: number;
  onBrandDiscountChange: (brandId: string, value: string) => void;
  onBrandDiscountClear: (brandId: string) => void;
  onClearAll: () => void;
}

/**
 * Lista de descuentos por marca. Un campo vacío significa "hereda el general";
 * los badges indican si el valor viene del cliente o fue ajustado manualmente.
 */
export function BrandDiscountsPanel({
  brands,
  brandDiscounts,
  baselineBrands,
  generalDiscount,
  onBrandDiscountChange,
  onBrandDiscountClear,
  onClearAll,
}: BrandDiscountsPanelProps) {
  const overridesCount = brands.filter((brand) => brandDiscounts[brand._id] !== undefined).length;

  if (brands.length === 0) {
    return <p className="mt-2 text-xs text-subtle">No hay marcas cargadas todavía.</p>;
  }

  return (
    <div className="mt-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-subtle">Campo vacío = usa el general ({generalDiscount}%).</p>
        {overridesCount > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            title="Quitar todos los descuentos por marca y volver al descuento general"
            className="shrink-0 text-xs font-semibold text-action-text underline"
          >
            Quitar ajustes ({overridesCount})
          </button>
        )}
      </div>

      <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
        {brands.map((brand) => {
          const override = brandDiscounts[brand._id];
          const hasOverride = override !== undefined;
          const baselineValue = baselineBrands[brand._id];
          const isFromClient =
            hasOverride && baselineValue !== undefined && override === baselineValue;

          return (
            <div key={brand._id} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted">{brand.name}</span>
              {isFromClient ? (
                <SourceBadge source="client" baselineValue={baselineValue} />
              ) : hasOverride ? (
                <SourceBadge source="manual" baselineValue={baselineValue} />
              ) : (
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-subtle">
                  General
                </span>
              )}
              <div className="relative shrink-0">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={hasOverride ? override : ''}
                  placeholder={`${generalDiscount}`}
                  onChange={(e) => onBrandDiscountChange(brand._id, e.target.value)}
                  title={`Descuento para ${brand.name}. Dejalo vacío para usar el general (${generalDiscount}%)`}
                  className={`h-8 w-16 rounded-sm border bg-field text-center text-xs font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30 ${
                    hasOverride
                      ? 'border-action pl-1.5 pr-5 ring-1 ring-action/30'
                      : 'border-border-strong px-1.5'
                  }`}
                />
                {hasOverride && (
                  <button
                    type="button"
                    onClick={() => onBrandDiscountClear(brand._id)}
                    title="Volver al descuento general"
                    aria-label={`Quitar el descuento manual de ${brand.name}`}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-subtle transition-colors hover:text-status-blocked"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Detalle de los descuentos aplicados según su origen (general, marca o manual),
 * para que el vendedor vea de dónde sale cada rebaja del total.
 */
export function DiscountBreakdown({ discountBySource }: { discountBySource: DiscountBySource }) {
  const rows = [
    {
      key: 'general',
      label: 'Desc. general',
      dot: 'bg-subtle',
      amount: discountBySource.general,
    },
    {
      key: 'brand',
      label: 'Desc. por marca',
      dot: 'bg-action',
      amount: discountBySource.brand,
    },
    {
      key: 'item',
      label: 'Desc. manual por producto',
      dot: 'bg-status-draft-border',
      amount: discountBySource.item,
    },
  ].filter((row) => row.amount > 0);

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className="flex justify-between text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${row.dot}`} aria-hidden="true" />
            {row.label}:
          </span>
          <span className="tabular-nums text-foreground">-${row.amount.toFixed(2)}</span>
        </div>
      ))}
    </>
  );
}
