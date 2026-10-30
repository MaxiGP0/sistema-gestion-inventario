'use client';

import { useState, useEffect, useId, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  PlusCircle,
  Package,
  Pencil,
  Trash2,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Percent,
} from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import ProductThumbnail from '@/components/ProductThumbnail';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import {
  Table,
  TableBody,
  TableCell,
  TableEmptyRow,
  TableHead,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
} from '@/components/ui/Table';
import { useToast } from '@/context/ToastContext';
import { api } from '@/lib/api-client';
import { invalidateCatalogCache } from '@/lib/catalog-query-cache';
import {
  calculateAdjustedPrices,
  formatAdjustmentPercentage,
  IVA_RATE,
  netPriceFromGross,
  parseAdjustmentPercentage,
  priceWithIvaFromNet,
  roundCurrency,
} from '@/lib/product-pricing';
import type {
  BrandDTO,
  BulkPriceAdjustmentResponse,
  DeleteResponse,
  ProductDTO,
  ProductListResponse,
  ProductMutationResponse,
} from '@/lib/types';

interface ProductsManagerProps {
  initialProducts: ProductDTO[];
  brands: BrandDTO[];
  initialSearch: string;
  initialBrandId: string;
  page: number;
  total: number;
  totalPages: number;
}

function buildProductsUrl(page: number, search: string, brandId: string): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (search) params.set('search', search);
  if (brandId) params.set('brandId', brandId);

  const queryString = params.toString();
  return queryString ? `/backoffice/products?${queryString}` : '/backoffice/products';
}

/**
 * Interacciones del backoffice de productos: formulario, búsqueda, edición,
 * baja y paginación. La lista y las marcas llegan resueltas del Server
 * Component; buscar/paginar navega con la URL y el servidor vuelve a consultar
 * la base (con la caché invalidada por tag).
 */
export default function ProductsManager({
  initialProducts,
  brands,
  initialSearch,
  initialBrandId,
  page,
  total,
  totalPages,
}: ProductsManagerProps) {
  const [products, setProducts] = useState<ProductDTO[]>(initialProducts);
  const [brandId, setBrandId] = useState(() => brands[0]?._id || '');
  const [filterBrandId, setFilterBrandId] = useState(() =>
    brands.some((brand) => brand._id === initialBrandId) ? initialBrandId : '',
  );
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [priceWithIva, setPriceWithIva] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Edición rápida de precio (mini-modal desde la tarjeta/fila).
  const [priceEditorProduct, setPriceEditorProduct] = useState<ProductDTO | null>(null);
  const [quickPrice, setQuickPrice] = useState('');
  const [quickPriceWithIva, setQuickPriceWithIva] = useState('');
  const [quickSaving, setQuickSaving] = useState(false);

  // Ajuste porcentual masivo por marca.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBrandId, setBulkBrandId] = useState('');
  const [bulkPercentage, setBulkPercentage] = useState('+10');
  const [bulkCount, setBulkCount] = useState<number | null>(null);
  const [bulkCountLoading, setBulkCountLoading] = useState(false);
  const [pendingBulk, setPendingBulk] = useState<{
    brandId: string;
    percentage: number;
  } | null>(null);

  const formCardRef = useRef<HTMLDivElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const quickPriceInputRef = useRef<HTMLInputElement>(null);
  const quickTitleId = useId();
  const quickDescriptionId = useId();
  const quickPriceInputId = useId();
  const quickPriceWithIvaInputId = useId();
  const bulkTitleId = useId();
  const bulkDescriptionId = useId();
  const bulkBrandSelectId = useId();
  const bulkPercentageInputId = useId();
  const { showToast } = useToast();
  const router = useRouter();

  // El listado puede cambiar por navegación o por un refresh del servidor.
  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

  // Mantiene el input alineado con la URL (atrás/adelante, refresh del server).
  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  // Mantiene el chip activo alineado con la URL.
  useEffect(() => {
    setFilterBrandId(brands.some((brand) => brand._id === initialBrandId) ? initialBrandId : '');
  }, [initialBrandId, brands]);

  // Si cambió el catálogo de marcas, asegura que el select tenga una opción válida.
  useEffect(() => {
    if (brands.length === 0) {
      if (brandId) setBrandId('');
      return;
    }
    if (!brands.some((brand) => brand._id === brandId)) {
      setBrandId(brands[0]._id);
    }
  }, [brands, brandId]);

  // Búsqueda con debounce: la consulta real la hace el Server Component.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === initialSearch) return;

    const timer = setTimeout(
      () => {
        startTransition(() => {
          router.replace(buildProductsUrl(1, trimmed, filterBrandId));
        });
      },
      trimmed ? 300 : 0,
    );

    return () => clearTimeout(timer);
  }, [search, initialSearch, filterBrandId, router]);

  const handleBrandFilterChange = (nextBrandId: string) => {
    if (nextBrandId === filterBrandId) return;

    setFilterBrandId(nextBrandId);
    startTransition(() => {
      router.replace(buildProductsUrl(1, search.trim(), nextBrandId));
    });
  };

  const handlePriceChange = (val: string) => {
    setPrice(val);
    const num = parseFloat(val);
    if (!isNaN(num)) {
      setPriceWithIva(priceWithIvaFromNet(num).toFixed(2));
    } else {
      setPriceWithIva('');
    }
  };

  const handlePriceWithIvaChange = (val: string) => {
    setPriceWithIva(val);
    const num = parseFloat(val);
    if (!isNaN(num)) {
      setPrice(netPriceFromGross(num).toFixed(2));
    } else {
      setPrice('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const url = editingId ? `/api/products/${editingId}` : '/api/products';
      const body = {
        brandId,
        code,
        name,
        price: Number(price),
        priceWithIva: Number(priceWithIva),
        imageUrl,
      };

      const data = editingId
        ? await api.put<ProductMutationResponse>(url, body)
        : await api.post<ProductMutationResponse>(url, body);

      showToast(data.message || 'Producto guardado exitosamente', 'success');
      invalidateCatalogCache('products');
      resetForm();
      router.refresh();
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (product: ProductDTO) => {
    setEditingId(product._id);
    setBrandId(product.brandId?._id || '');
    setCode(product.code);
    setName(product.name);
    setPrice(String(product.price));
    setPriceWithIva(String(product.priceWithIva || priceWithIvaFromNet(product.price).toFixed(2)));
    setImageUrl(product.imageUrl || '');

    // En mobile el formulario queda arriba de la lista: al tocar "Editar"
    // llevamos al usuario hasta él y enfocamos el primer campo editable.
    requestAnimationFrame(() => {
      formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      codeInputRef.current?.focus({ preventScroll: true });
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setCode('');
    setName('');
    setPrice('');
    setPriceWithIva('');
    setImageUrl('');
    if (brands.length > 0) setBrandId(brands[0]._id);
  };

  const openPriceEditor = (product: ProductDTO) => {
    setPriceEditorProduct(product);
    setQuickPrice(roundCurrency(product.price).toFixed(2));
    setQuickPriceWithIva(
      roundCurrency(
        typeof product.priceWithIva === 'number'
          ? product.priceWithIva
          : priceWithIvaFromNet(product.price),
      ).toFixed(2),
    );
  };

  const closePriceEditor = () => {
    if (quickSaving) return;
    setPriceEditorProduct(null);
  };

  const handleQuickPriceChange = (val: string) => {
    setQuickPrice(val);
    const num = parseFloat(val);
    setQuickPriceWithIva(!isNaN(num) && num >= 0 ? priceWithIvaFromNet(num).toFixed(2) : '');
  };

  const handleQuickPriceWithIvaChange = (val: string) => {
    setQuickPriceWithIva(val);
    const num = parseFloat(val);
    setQuickPrice(!isNaN(num) && num >= 0 ? netPriceFromGross(num).toFixed(2) : '');
  };

  /**
   * Guarda la edición rápida sin navegar ni recargar la página: se actualiza
   * la fila en memoria para conservar la posición del scroll en la lista.
   */
  const handleQuickPriceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const product = priceEditorProduct;
    if (!product) return;

    const net = roundCurrency(Number(quickPrice));
    const gross = roundCurrency(Number(quickPriceWithIva));

    if (!Number.isFinite(net) || net < 0 || !Number.isFinite(gross) || gross < 0) {
      showToast('Ingresá precios válidos (mayores o iguales a 0)', 'error');
      return;
    }

    setQuickSaving(true);
    try {
      const data = await api.put<ProductMutationResponse>(`/api/products/${product._id}`, {
        brandId: product.brandId?._id || '',
        code: product.code,
        name: product.name,
        price: net,
        priceWithIva: gross,
        imageUrl: product.imageUrl || '',
      });

      setProducts((prev) =>
        prev.map((item) =>
          item._id === product._id ? { ...item, price: net, priceWithIva: gross } : item,
        ),
      );
      invalidateCatalogCache('products');
      showToast(data.message || 'Precio actualizado exitosamente', 'success');
      setPriceEditorProduct(null);
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setQuickSaving(false);
    }
  };

  // Alcance real del ajuste: se consulta el total activo de la marca elegida.
  useEffect(() => {
    if (!bulkOpen) return;

    let cancelled = false;
    const params = new URLSearchParams({ page: '1', limit: '1' });
    if (bulkBrandId) params.set('brandId', bulkBrandId);

    setBulkCountLoading(true);
    setBulkCount(null);

    api
      .get<ProductListResponse>(`/api/products?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setBulkCount(data.total);
      })
      .catch(() => {
        if (!cancelled) setBulkCount(null);
      })
      .finally(() => {
        if (!cancelled) setBulkCountLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [bulkOpen, bulkBrandId]);

  const openBulkPriceModal = () => {
    setBulkBrandId(filterBrandId);
    setBulkPercentage('+10');
    setBulkOpen(true);
  };

  const bulkPercentageValue = parseAdjustmentPercentage(bulkPercentage);

  const handleBulkSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (bulkPercentageValue === null) {
      showToast('Ingresá un porcentaje válido (ej. +10% o -5%)', 'error');
      return;
    }
    if (bulkCountLoading) return;
    if (bulkCount === null) {
      showToast('No se pudo calcular el alcance del ajuste', 'error');
      return;
    }
    if (bulkCount === 0) {
      showToast('No hay productos activos para ajustar con ese filtro', 'error');
      return;
    }

    setPendingBulk({ brandId: bulkBrandId, percentage: bulkPercentageValue });
    setBulkOpen(false);
  };

  const handleApplyBulkAdjustment = async () => {
    const target = pendingBulk;
    if (!target) return;

    try {
      const data = await api.post<BulkPriceAdjustmentResponse>('/api/products/bulk-price', {
        brandId: target.brandId || undefined,
        percentage: target.percentage,
      });

      // Feedback inmediato: las filas visibles se actualizan sin esperar el RSC.
      setProducts((prev) =>
        prev.map((product) =>
          !target.brandId || product.brandId?._id === target.brandId
            ? { ...product, ...calculateAdjustedPrices(product, target.percentage) }
            : product,
        ),
      );
      invalidateCatalogCache('products');
      showToast(data.message || 'Precios actualizados exitosamente', 'success');
      startTransition(() => router.refresh());
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setPendingBulk(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const data = await api.delete<DeleteResponse>(`/api/products/${id}`);

      showToast(data.message || 'Producto eliminado exitosamente', 'success');
      invalidateCatalogCache('products');
      if (editingId === id) resetForm();
      router.refresh();
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    }
  };

  const goToPage = (targetPage: number) => {
    if (targetPage < 1 || targetPage > totalPages || targetPage === page) return;
    startTransition(() => {
      router.push(buildProductsUrl(targetPage, search.trim(), filterBrandId));
    });
  };

  const emptyMessage = search.trim()
    ? 'No se encontraron productos que coincidan con la búsqueda.'
    : filterBrandId
      ? 'No hay productos para la marca seleccionada.'
      : isPending
        ? 'Cargando productos...'
        : 'No hay productos registrados aún. Agrega uno o importa un Excel.';

  const pendingBulkBrand = pendingBulk?.brandId
    ? brands.find((brand) => brand._id === pendingBulk.brandId)
    : null;
  const bulkConfirmMessage = pendingBulk
    ? `Se aplicará ${formatAdjustmentPercentage(pendingBulk.percentage)} a ${bulkCount ?? 0} producto(s) activo(s) ${
        pendingBulkBrand ? `de ${pendingBulkBrand.name}` : 'de todas las marcas'
      }. ¿Confirmás el ajuste?`
    : '';

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        {/* Formulario de Alta / Edición Manual */}
        <div ref={formCardRef} className="scroll-mt-24">
          <Card className={`h-fit transition-shadow ${editingId ? 'ring-2 ring-focus/40' : ''}`}>
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <PlusCircle className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {editingId ? 'Editar Producto' : 'Nuevo Producto'}
                </h2>
                <p className="text-xs text-muted">
                  {editingId ? 'Modificar datos del producto' : 'Alta o actualización unitaria'}
                </p>
              </div>
            </div>

            {editingId && (
              <div
                role="status"
                aria-live="polite"
                data-testid="product-editing-indicator"
                className="mb-4 flex items-start gap-2 rounded-lg border border-action/30 bg-action-soft px-3 py-2 text-xs text-action-text"
              >
                <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  <span className="font-semibold">Editando</span>{' '}
                  {code ? `${code} · ${name}` : 'producto seleccionado'}
                </span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">Marca</label>
                <select
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  required
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                >
                  {brands.map((b) => (
                    <option key={b._id} value={b._id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Código del Producto
                </label>
                <input
                  ref={codeInputRef}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  placeholder="Ej: C1020 o 5040"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Nombre del Producto
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Ej: Shampoo Capitalis 400ml"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Precio Unitario s/IVA ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={price}
                  onChange={(e) => handlePriceChange(e.target.value)}
                  required
                  placeholder="0.00"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Precio Unitario c/IVA ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={priceWithIva}
                  onChange={(e) => handlePriceWithIvaChange(e.target.value)}
                  required
                  placeholder="0.00"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  URL de Imagen (Opcional)
                </label>
                <input
                  type="text"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://..."
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  disabled={loading}
                  className="py-2.5 text-sm"
                >
                  {loading ? 'Guardando...' : editingId ? 'Actualizar' : 'Guardar Producto'}
                </Button>
                {editingId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={resetForm}
                    className="px-3 py-2.5"
                    title="Cancelar"
                    aria-label="Cancelar edición"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </form>
          </Card>
        </div>

        {/* Listado de Productos Existentes */}
        <Card className="lg:col-span-2 flex flex-col ">
          <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <Package className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Catálogo Actual</h2>
                <p className="text-xs text-muted">
                  {search.trim() || filterBrandId
                    ? `Mostrando ${products.length} de ${total} productos`
                    : `Total de productos registrados: ${total}`}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={openBulkPriceModal}
                data-testid="bulk-price-open"
              >
                <Percent className="h-3.5 w-3.5" aria-hidden="true" />
                Ajustar precios por marca
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push('/backoffice/import')}
              >
                Ir a Importación Masiva (Excel)
              </Button>
            </div>
          </div>

          <div className={`flex-1 transition-opacity ${isPending ? 'opacity-60' : 'opacity-100'}`}>
            {/* Buscador de Productos */}
            <div className="relative mb-4">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted">
                <Search className="w-4 h-4" />
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por código, nombre o marca..."
                aria-label="Buscar productos por código, nombre o marca"
                className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-12 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm   "
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Limpiar búsqueda de productos"
                  title="Limpiar búsqueda"
                  className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-muted transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {/* Filtro horizontal por marca */}
            <div
              role="group"
              aria-label="Filtrar por marca"
              data-testid="backoffice-brand-filter"
              className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              <Button
                type="button"
                variant={filterBrandId ? 'secondary' : 'primary'}
                size="sm"
                aria-pressed={!filterBrandId}
                onClick={() => handleBrandFilterChange('')}
                className="shrink-0 rounded-full"
              >
                Todas
              </Button>
              {brands.map((brand) => {
                const isActive = brand._id === filterBrandId;

                return (
                  <Button
                    key={brand._id}
                    type="button"
                    variant={isActive ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={isActive}
                    onClick={() => handleBrandFilterChange(brand._id)}
                    className="shrink-0 rounded-full"
                  >
                    {brand.name}
                  </Button>
                );
              })}
            </div>

            {/* Mobile Card View */}
            <div className="block sm:hidden space-y-3">
              {products.length === 0 ? (
                <div className="py-8 text-center text-muted text-xs">{emptyMessage}</div>
              ) : (
                products.map((p) => (
                  <div
                    key={`mob-${p._id}`}
                    data-testid="backoffice-product-card"
                    className="space-y-3 rounded-lg border border-border bg-surface-muted p-4"
                  >
                    <div className="flex items-start gap-3">
                      <ProductThumbnail
                        src={p.imageUrl}
                        alt={p.name}
                        size={48}
                        className="shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-semibold text-status-draft">
                          {p.brandId?.name || 'N/A'}
                        </span>
                        <h4 className="font-semibold text-sm mt-0.5 break-words text-foreground">
                          {p.name}
                        </h4>
                        <span className="font-mono text-xs text-muted">Código: {p.code}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border">
                      <button
                        type="button"
                        onClick={() => openPriceEditor(p)}
                        aria-label={`Cambiar precio de ${p.name}`}
                        title="Cambiar precio"
                        className="min-h-11 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <span className="block text-sm font-extrabold text-foreground">
                          ${p.price.toFixed(2)}{' '}
                          <span className="text-[10px] font-normal text-subtle">s/IVA</span>
                        </span>
                        <span className="block text-xs font-semibold text-action-text">
                          ${(p.priceWithIva || priceWithIvaFromNet(p.price)).toFixed(2)}{' '}
                          <span className="text-[10px] font-normal text-subtle">c/IVA</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-muted">
                          <CircleDollarSign className="h-3 w-3" aria-hidden="true" />
                          Cambiar precio
                        </span>
                      </button>
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="icon"
                          onClick={() => handleEdit(p)}
                          title="Editar"
                          aria-label={`Editar ${p.name}`}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          tone="red"
                          appearance="ghost"
                          size="icon"
                          onClick={() => setPendingDeleteId(p._id)}
                          title="Eliminar"
                          aria-label={`Eliminar ${p.name}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table View */}
            <div className="hidden sm:block">
              <Table>
                <TableHead>
                  <TableHeaderRow>
                    <TableHeaderCell>Marca</TableHeaderCell>
                    <TableHeaderCell>Código</TableHeaderCell>
                    <TableHeaderCell>Nombre</TableHeaderCell>
                    <TableHeaderCell align="right">Precio s/IVA</TableHeaderCell>
                    <TableHeaderCell align="right">Precio c/IVA</TableHeaderCell>
                    <TableHeaderCell align="right">Acciones</TableHeaderCell>
                  </TableHeaderRow>
                </TableHead>
                <TableBody>
                  {products.length === 0 ? (
                    <TableEmptyRow colSpan={6}>{emptyMessage}</TableEmptyRow>
                  ) : (
                    products.map((p) => (
                      <TableRow key={p._id} hover>
                        <TableCell className="font-medium text-status-draft">
                          {p.brandId?.name || 'N/A'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-foreground">
                          {p.code}
                        </TableCell>
                        <TableCell className="text-foreground">
                          <span className="flex items-center gap-2">
                            <ProductThumbnail
                              src={p.imageUrl}
                              alt={p.name}
                              size={40}
                              className="shrink-0"
                            />
                            <span>{p.name}</span>
                          </span>
                        </TableCell>
                        <TableCell align="right" className="font-semibold text-foreground">
                          ${p.price.toFixed(2)}
                        </TableCell>
                        <TableCell align="right" className="font-semibold text-action-text">
                          ${(p.priceWithIva || priceWithIvaFromNet(p.price)).toFixed(2)}
                        </TableCell>
                        <TableCell align="right" className="whitespace-nowrap space-x-2">
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => openPriceEditor(p)}
                            title="Cambiar precio"
                            aria-label={`Cambiar precio de ${p.name}`}
                          >
                            <CircleDollarSign className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => handleEdit(p)}
                            title="Editar"
                            aria-label={`Editar ${p.name}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            tone="red"
                            appearance="ghost"
                            size="icon-sm"
                            onClick={() => setPendingDeleteId(p._id)}
                            title="Eliminar"
                            aria-label={`Eliminar ${p.name}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Paginación en servidor */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1 || isPending}
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Anterior
                </Button>
                <span className="text-xs text-muted">
                  Página {page} de {totalPages}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages || isPending}
                >
                  Siguiente <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Edición rápida de precio sin salir de la lista */}
      <Modal
        open={priceEditorProduct !== null}
        onClose={closePriceEditor}
        labelledBy={quickTitleId}
        describedBy={quickDescriptionId}
        variant="responsive"
        initialFocusRef={quickPriceInputRef}
      >
        <form onSubmit={handleQuickPriceSubmit} data-testid="quick-price-modal">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={quickTitleId} className="text-base font-semibold">
                Cambiar precio
              </h2>
              <p id={quickDescriptionId} className="mt-1 text-sm text-muted">
                {priceEditorProduct
                  ? `${priceEditorProduct.brandId?.name || 'N/A'} · ${priceEditorProduct.code} · ${priceEditorProduct.name}`
                  : ''}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={closePriceEditor}
              title="Cerrar"
              aria-label="Cerrar edición de precio"
              disabled={quickSaving}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label
                htmlFor={quickPriceInputId}
                className="mb-1 block text-xs font-semibold text-foreground"
              >
                Precio s/IVA
              </label>
              <input
                id={quickPriceInputId}
                ref={quickPriceInputRef}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={quickPrice}
                onChange={(e) => handleQuickPriceChange(e.target.value)}
                required
                className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
              />
            </div>
            <div>
              <label
                htmlFor={quickPriceWithIvaInputId}
                className="mb-1 block text-xs font-semibold text-foreground"
              >
                Precio c/IVA
              </label>
              <input
                id={quickPriceWithIvaInputId}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={quickPriceWithIva}
                onChange={(e) => handleQuickPriceWithIvaChange(e.target.value)}
                required
                className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
              />
              <p className="mt-1 text-[11px] text-muted">
                El IVA ({Math.round((IVA_RATE - 1) * 100)}%) se calcula automáticamente al editar
                cualquiera de los dos importes.
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={closePriceEditor}
              disabled={quickSaving}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={quickSaving}
              loadingLabel="Guardando..."
            >
              Guardar precio
            </Button>
          </div>
        </form>
      </Modal>

      {/* Ajuste porcentual masivo por marca */}
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        labelledBy={bulkTitleId}
        describedBy={bulkDescriptionId}
        variant="responsive"
      >
        <form onSubmit={handleBulkSubmit} data-testid="bulk-price-modal">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={bulkTitleId} className="text-base font-semibold">
                Ajustar precios por marca
              </h2>
              <p id={bulkDescriptionId} className="mt-1 text-sm text-muted">
                Aplicá un porcentaje a todos los productos activos de una marca o del catálogo
                completo.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setBulkOpen(false)}
              title="Cerrar"
              aria-label="Cerrar ajuste de precios"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label
                htmlFor={bulkBrandSelectId}
                className="mb-1 block text-xs font-semibold text-foreground"
              >
                Marca a ajustar
              </label>
              <select
                id={bulkBrandSelectId}
                value={bulkBrandId}
                onChange={(e) => setBulkBrandId(e.target.value)}
                className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
              >
                <option value="">Todas las marcas</option>
                {brands.map((brand) => (
                  <option key={brand._id} value={brand._id}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor={bulkPercentageInputId}
                className="mb-1 block text-xs font-semibold text-foreground"
              >
                Porcentaje de ajuste
              </label>
              <input
                id={bulkPercentageInputId}
                type="text"
                inputMode="decimal"
                value={bulkPercentage}
                onChange={(e) => setBulkPercentage(e.target.value)}
                placeholder="Ej: +10% o -5%"
                className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
              />
              {bulkPercentage.trim() && bulkPercentageValue === null && (
                <p role="alert" className="mt-1 text-[11px] text-status-blocked">
                  Ingresá un porcentaje válido entre -100% y 1000%, distinto de 0.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
              <span className="text-muted">Alcanza a </span>
              <strong data-testid="bulk-price-count" aria-live="polite" className="font-semibold">
                {bulkCountLoading
                  ? 'calculando...'
                  : bulkCount === null
                    ? 'sin datos'
                    : `${bulkCount} producto(s) activo(s)`}
              </strong>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setBulkOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                bulkPercentageValue === null ||
                bulkCountLoading ||
                bulkCount === null ||
                bulkCount === 0
              }
            >
              Continuar
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingBulk !== null}
        title="Ajustar precios por marca"
        message={bulkConfirmMessage}
        confirmLabel="Aplicar ajuste"
        variant="primary"
        onClose={() => setPendingBulk(null)}
        onConfirm={handleApplyBulkAdjustment}
      />

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Eliminar producto"
        message="¿Estás seguro de eliminar este producto? Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        variant="danger"
        onClose={() => setPendingDeleteId(null)}
        onConfirm={async () => {
          if (pendingDeleteId) await handleDelete(pendingDeleteId);
        }}
      />
    </>
  );
}
