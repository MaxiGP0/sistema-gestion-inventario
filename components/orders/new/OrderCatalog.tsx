'use client';

import { useMemo, useState } from 'react';
import { Search, ShoppingCart, Tag, Trash2, X } from 'lucide-react';
import type { OrderCatalogState } from '@/hooks/useOrderCatalog';
import {
  countSelectedItems,
  SELECTED_PRODUCTS_FILTER,
  type DiscountMap,
  type OrderCatalogBrand,
  type QuantityMap,
} from '@/lib/order-catalog';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import FilterChips from '@/components/ui/FilterChips';
import {
  Table,
  TableBody,
  TableHead,
  TableHeaderCell,
  TableHeaderRow,
} from '@/components/ui/Table';
import { ProductCardMobile, ProductRowDesktop } from '@/components/orders/new/CatalogProductRow';
import { SourceBadge } from '@/components/orders/new/OrderDiscounts';

interface OrderCatalogProps {
  brands: OrderCatalogBrand[];
  catalog: OrderCatalogState;
  quantities: QuantityMap;
  itemDiscounts: DiscountMap;
  generalDiscount: number;
  brandDiscounts: DiscountMap;
  baselineBrands: DiscountMap;
  onQuantityChange: (productId: string, value: string) => void;
  onQuantityDelta: (productId: string, delta: number) => void;
  onDiscountChange: (productId: string, value: string) => void;
  onDiscountClear: (productId: string) => void;
  onBrandDiscountChange: (brandId: string, value: string) => void;
  onBrandDiscountClear: (brandId: string) => void;
  onClearCart: () => void;
}

/**
 * Catálogo del alta de pedidos: buscador, filtros por marca, tabla de
 * escritorio/tarjetas móviles y carga incremental.
 */
export default function OrderCatalog({
  brands,
  catalog,
  quantities,
  itemDiscounts,
  generalDiscount,
  brandDiscounts,
  baselineBrands,
  onQuantityChange,
  onQuantityDelta,
  onDiscountChange,
  onDiscountClear,
  onBrandDiscountChange,
  onBrandDiscountClear,
  onClearCart,
}: OrderCatalogProps) {
  const {
    products,
    productsByBrand,
    productsTotal,
    loadingProducts,
    hasMoreProducts,
    hasCatalogFilter,
    searchTerm,
    setSearchTerm,
    selectedBrandFilter,
    setSelectedBrandFilter,
    loadMoreProducts,
  } = catalog;

  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const selectedCount = useMemo(() => countSelectedItems(quantities).distinct, [quantities]);
  const selectedFilterActive = selectedBrandFilter === SELECTED_PRODUCTS_FILTER;
  const emptyTitle = selectedFilterActive
    ? loadingProducts
      ? 'Recuperando productos'
      : 'No hay productos seleccionados'
    : loadingProducts
      ? 'Buscando productos'
      : hasCatalogFilter
        ? 'Sin resultados'
        : 'Seleccioná una marca';
  const emptyDescription = selectedFilterActive
    ? loadingProducts
      ? 'Estamos recuperando los productos de tu pedido.'
      : 'Agregá productos al pedido desde el catálogo.'
    : loadingProducts
      ? 'Estamos consultando el catálogo.'
      : hasCatalogFilter
        ? 'No se encontraron productos con ese criterio. Probá con otro nombre, código o marca.'
        : 'Buscá un producto por nombre o código para comenzar.';

  const handleSearchChange = (value: string) => {
    // Buscar en el catálogo completo: si estaba activo "Seleccionados", el
    // texto escrito deja de ser un filtro de carrito y pasa a buscar productos.
    if (value.trim() && selectedFilterActive) setSelectedBrandFilter('ALL');
    setSearchTerm(value);
  };

  return (
    <>
      <Card padding="none" className="p-4 sm:p-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground lg:hidden">
          <ShoppingCart className="h-4 w-4 text-action-text" aria-hidden="true" /> 2. Productos
        </h2>
        <div
          data-testid="catalog-sticky-toolbar"
          className="sticky top-16 z-20 -mx-4 mb-4 bg-surface/95 px-4 py-2 backdrop-blur-sm sm:static sm:mx-0 sm:mb-4 sm:bg-transparent sm:p-0"
        >
          <div className="mb-2 flex flex-col justify-between gap-3 sm:mb-4 sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-72">
              <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-subtle">
                <Search className="h-4 w-4" aria-hidden="true" />
              </span>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Buscar producto por nombre o código..."
                className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-11 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  aria-label="Limpiar búsqueda de productos"
                  title="Limpiar búsqueda"
                  className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center rounded-r-md text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {selectedCount > 0 && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setConfirmClearOpen(true)}
                className="shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Vaciar carrito
              </Button>
            )}
          </div>

          <FilterChips
            ariaLabel="Filtrar por marca"
            value={selectedBrandFilter}
            onChange={setSelectedBrandFilter}
            className="mb-0 sm:mb-2"
            items={[
              ...(selectedCount > 0
                ? [
                    {
                      value: SELECTED_PRODUCTS_FILTER,
                      label: `Seleccionados (${selectedCount})`,
                      testId: 'selected-products-filter',
                    },
                  ]
                : []),
              { value: 'ALL', label: 'Todas las Marcas' },
              ...brands.map((brand) => ({ value: brand._id, label: brand.name })),
            ]}
          />
        </div>

        {/* Listado agrupado por marcas */}
        {productsByBrand.length === 0 ? (
          <EmptyState
            icon={Tag}
            title={emptyTitle}
            description={emptyDescription}
            className="border-0"
          />
        ) : (
          productsByBrand.map(({ brandId, brandName, products: brandProducts }) => {
            const brandOverride = brandDiscounts[brandId];
            const brandHasOverride = brandOverride !== undefined;
            const brandBaseline = baselineBrands[brandId];
            const brandDefDisc = brandHasOverride ? brandOverride : generalDiscount;
            const brandIsFromClient =
              brandHasOverride && brandBaseline !== undefined && brandOverride === brandBaseline;

            return (
              <div key={brandId} className="mb-8 border-b border-border pb-4 last:mb-0">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Tag className="h-4 w-4 text-action-text" aria-hidden="true" /> {brandName}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted">Desc. marca (%):</span>
                    <div className="relative">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        value={brandHasOverride ? brandOverride : ''}
                        placeholder={`${generalDiscount}`}
                        onChange={(e) => onBrandDiscountChange(brandId, e.target.value)}
                        aria-label={`Descuento para ${brandName}`}
                        title={`Descuento para ${brandName}. Dejalo vacío para usar el general (${generalDiscount}%)`}
                        className={`h-8 w-14 rounded-sm border bg-field px-1 text-center text-xs font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30 ${
                          brandHasOverride
                            ? 'border-action pl-1 pr-4 ring-1 ring-action/30'
                            : 'border-border-strong'
                        }`}
                      />
                      {brandHasOverride && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => onBrandDiscountClear(brandId)}
                          title="Volver al descuento general"
                          aria-label={`Quitar el descuento manual de ${brandName}`}
                          className="absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2 p-0"
                        >
                          <X className="h-2.5 w-2.5" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    {brandIsFromClient ? (
                      <SourceBadge source="client" baselineValue={brandBaseline} />
                    ) : brandHasOverride ? (
                      <SourceBadge source="manual" baselineValue={brandBaseline} />
                    ) : (
                      <span className="text-[11px] text-subtle">usa el general</span>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Mobile Card View (No horizontal scroll needed) */}
                  <div className="block sm:hidden space-y-3">
                    {brandProducts.map((product) => (
                      <ProductCardMobile
                        key={`mob-${product._id}`}
                        product={product}
                        qty={quantities[product._id] || ''}
                        disc={
                          itemDiscounts[product._id] !== undefined ? itemDiscounts[product._id] : ''
                        }
                        defaultDiscount={brandDefDisc}
                        onQuantityChange={onQuantityChange}
                        onQuantityDelta={onQuantityDelta}
                        onDiscountChange={onDiscountChange}
                        onDiscountClear={onDiscountClear}
                      />
                    ))}
                  </div>

                  {/* Desktop Table View */}
                  <div className="hidden sm:block">
                    <Table dense>
                      <TableHead>
                        <TableHeaderRow>
                          <TableHeaderCell align="center" className="w-16 py-2.5">
                            Imagen
                          </TableHeaderCell>
                          <TableHeaderCell className="w-32 py-2.5">Código</TableHeaderCell>
                          <TableHeaderCell className="py-2.5">Producto</TableHeaderCell>
                          <TableHeaderCell align="right" className="w-28 py-2.5">
                            Precio s/IVA
                          </TableHeaderCell>
                          <TableHeaderCell align="right" className="w-28 py-2.5">
                            Precio c/IVA
                          </TableHeaderCell>
                          <TableHeaderCell
                            align="center"
                            className="w-28 py-2.5"
                            title="Sin editar aplica el descuento de la marca. Escribí un valor para ajustar el producto."
                          >
                            Desc. (%)
                          </TableHeaderCell>
                          <TableHeaderCell align="center" className="w-36 py-2.5">
                            Cantidad
                          </TableHeaderCell>
                        </TableHeaderRow>
                      </TableHead>
                      <TableBody>
                        {brandProducts.map((product) => (
                          <ProductRowDesktop
                            key={product._id}
                            product={product}
                            qty={quantities[product._id] || ''}
                            disc={
                              itemDiscounts[product._id] !== undefined
                                ? itemDiscounts[product._id]
                                : ''
                            }
                            defaultDiscount={brandDefDisc}
                            onQuantityChange={onQuantityChange}
                            onQuantityDelta={onQuantityDelta}
                            onDiscountChange={onDiscountChange}
                            onDiscountClear={onDiscountClear}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Contador y carga incremental del catálogo */}
        {products.length > 0 && (
          <div className="pt-4 flex flex-col items-center gap-3">
            <span className="text-xs text-muted">
              Mostrando {products.length} de {productsTotal} productos
            </span>
            {hasMoreProducts && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={loadMoreProducts}
                disabled={loadingProducts}
                className="px-5 py-2.5"
              >
                {loadingProducts
                  ? 'Cargando...'
                  : `Cargar más productos (${productsTotal - products.length} restantes)`}
              </Button>
            )}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmClearOpen}
        title="Vaciar carrito"
        message={`Se quitarán los ${selectedCount} productos cargados y sus descuentos manuales. Esta acción no se puede deshacer.`}
        confirmLabel="Vaciar carrito"
        variant="danger"
        onConfirm={onClearCart}
        onClose={() => setConfirmClearOpen(false)}
      />
    </>
  );
}
