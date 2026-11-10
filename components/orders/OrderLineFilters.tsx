'use client';

import { Search, X } from 'lucide-react';
import FilterChips from '@/components/ui/FilterChips';
import type {
  OrderLineBrandCount,
  OrderLineFilter,
  OrderLineFilterCounts,
} from '@/lib/order-line-filter';

interface OrderLineFiltersProps {
  counts: OrderLineFilterCounts;
  filter: OrderLineFilter;
  onFilterChange: (filter: OrderLineFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Marcas presentes en el pedido, ya ordenadas y con su conteo. */
  brands: readonly OrderLineBrandCount[];
  /** Marca activa (`'all'` para todas). */
  brandFilter: string;
  onBrandFilterChange: (brand: string) => void;
}

const FILTERS: Array<{ value: OrderLineFilter; label: (counts: OrderLineFilterCounts) => string }> =
  [
    { value: 'all', label: (counts) => `Todas (${counts.all})` },
    { value: 'pending', label: (counts) => `Pendientes (${counts.pending})` },
    {
      value: 'difference',
      label: (counts) => `Con diferencia / Faltantes (${counts.difference})`,
    },
  ];

/**
 * Chips + buscador para pedidos largos. Sólo se monta cuando el pedido supera
 * las 5 líneas, así que no agrega ruido en los pedidos cortos. Los chips de
 * marca aparecen únicamente cuando el pedido mezcla dos o más marcas.
 */
export default function OrderLineFilters({
  counts,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  brands,
  brandFilter,
  onBrandFilterChange,
}: OrderLineFiltersProps) {
  return (
    <div
      // En mobile la barra queda debajo del top bar (64 px) mientras se
      // recorre el pedido; en desktop vuelve al flujo normal. El padding y el
      // margen negativo de los chips mantienen las filas compactas.
      className="sticky top-16 z-20 rounded-lg border border-border bg-surface/95 p-2 backdrop-blur-sm sm:static sm:z-auto sm:space-y-2 sm:bg-surface-muted sm:p-2.5 sm:backdrop-blur-none"
      data-testid="line-filter-bar"
    >
      <FilterChips
        ariaLabel="Filtrar líneas del pedido"
        value={filter}
        onChange={(value) => onFilterChange(value as OrderLineFilter)}
        className="max-sm:-mb-1"
        items={FILTERS.map((option) => ({
          value: option.value,
          label: option.label(counts),
          testId: `line-filter-${option.value}`,
        }))}
      />

      {brands.length > 1 && (
        <FilterChips
          ariaLabel="Filtrar líneas por marca"
          value={brandFilter}
          onChange={onBrandFilterChange}
          dataTestId="line-brand-filters"
          itemTestIdPrefix="line-brand-filter-"
          className="max-sm:-mb-1 max-sm:mt-1 sm:mt-0"
          items={[
            { value: 'all', label: 'Todas las marcas', testId: 'line-brand-filter-all' },
            ...brands.map((brand, index) => ({
              value: brand.name,
              label: `${brand.name} (${brand.count})`,
              testId: `line-brand-filter-${index}`,
            })),
          ]}
        />
      )}

      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-subtle">
          <Search className="h-4 w-4" aria-hidden="true" />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Buscar por código o nombre..."
          aria-label="Buscar línea por código o nombre"
          data-testid="line-filter-search"
          className="h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-11 text-base text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30 md:text-xs"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Limpiar búsqueda de líneas"
            className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center text-subtle transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
