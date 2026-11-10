'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, ChevronLeft, ChevronRight, Search, ShoppingCart, X } from 'lucide-react';
import AppShell from '@/components/app-shell/AppShell';
import ProductThumbnail from '@/components/ProductThumbnail';
import OfflineCatalogBadge from '@/components/orders/new/OfflineCatalogBadge';
import OfflineCatalogSyncProgress from '@/components/orders/new/OfflineCatalogSyncProgress';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import FilterChips from '@/components/ui/FilterChips';
import QuantityStepper from '@/components/ui/QuantityStepper';
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
import { useUser } from '@/context/UserContext';
import { useCatalogFocusRevalidation } from '@/hooks/useCatalogFocusRevalidation';
import { useUrlSearchSync } from '@/hooks/useUrlSearchSync';
import type { UserRole } from '@/lib/authz';
import { PRODUCTS_PAGE_SIZE } from '@/lib/catalog-pagination';
import { vibrateOnTap } from '@/lib/haptics';
import { countSelectedItems, type QuantityMap } from '@/lib/order-catalog';
import {
  adjustOrderDraftProduct,
  loadOrderDraft,
  saveOrderDraft,
  type OrderDraftStorage,
} from '@/lib/order-draft';
import { searchOfflineCatalogProducts } from '@/lib/offline-catalog';
import {
  isBrowserOffline,
  rememberOfflineCatalogBrands,
  rememberOfflineCatalogProducts,
  syncOfflineCatalog,
} from '@/lib/offline-catalog-sync';
import type { BrandDTO, ProductDTO } from '@/lib/types';
import CatalogTabs from './CatalogTabs';

interface CatalogBrowserProps {
  initialProducts: ProductDTO[];
  brands: BrandDTO[];
  initialSearch: string;
  initialBrandId: string;
  page: number;
  total: number;
  totalPages: number;
  role: UserRole;
  username: string;
}

interface LocalCatalogPage {
  items: ProductDTO[];
  total: number;
  page: number;
  totalPages: number;
}

function buildCatalogUrl(page: number, search: string, brandId: string): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (search) params.set('search', search);
  if (brandId) params.set('brandId', brandId);

  const queryString = params.toString();
  return queryString ? `/catalog?${queryString}` : '/catalog';
}

function getBrowserDraftStorage(): OrderDraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Controles compactos para cargar un producto en el borrador del pedido sin
 * salir del catálogo. Con cantidad 0 ofrecen "+ Pedido"; con cantidad > 0,
 * permiten escribir el número directo, ajustar con -/+ o sumar medias docenas.
 */
function DraftProductControls({
  product,
  quantity,
  onDelta,
}: {
  product: ProductDTO;
  quantity: number;
  onDelta: (productId: string, delta: number) => void;
}) {
  const applyDelta = (delta: number) => {
    vibrateOnTap();
    onDelta(product._id, delta);
  };

  if (quantity <= 0) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => applyDelta(1)}
        aria-label={`+ Pedido: ${product.name}`}
        className="shrink-0 rounded-full font-semibold"
      >
        + Pedido
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <QuantityStepper
        value={quantity}
        onChange={(value) => onDelta(product._id, value - quantity)}
        min={0}
        max={99999}
        label={`Cantidad de ${product.name} en el borrador`}
        decreaseLabel={`Restar una unidad de ${product.name} del pedido`}
        increaseLabel={`Sumar una unidad de ${product.name} al pedido`}
        className="shrink-0"
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => applyDelta(6)}
        aria-label={`Sumar 6 unidades de ${product.name}`}
        className="px-2 font-semibold"
      >
        +6
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => applyDelta(12)}
        aria-label={`Sumar 12 unidades de ${product.name}`}
        className="px-2 font-semibold"
      >
        +12
      </Button>
    </div>
  );
}

/**
 * Catálogo para vendedores y controladores. Con red, la búsqueda, el filtro por
 * marca y la paginación navegan con la URL y el Server Component consulta la
 * base. Sin red, esas mismas acciones se resuelven contra el snapshot de
 * IndexedDB y se muestra el aviso de datos guardados.
 */
export default function CatalogBrowser({
  initialProducts,
  brands,
  initialSearch,
  initialBrandId,
  page: serverPage,
  total: serverTotal,
  totalPages: serverTotalPages,
  role,
  username,
}: CatalogBrowserProps) {
  const { user } = useUser();
  const userId = user?.id ?? '';
  const [search, setSearch] = useState(initialSearch);
  const [brandId, setBrandId] = useState(() =>
    brands.some((brand) => brand._id === initialBrandId) ? initialBrandId : '',
  );
  const [isPending, startTransition] = useTransition();
  const [isOffline, setIsOffline] = useState(false);
  const [offlinePage, setOfflinePage] = useState<LocalCatalogPage | null>(null);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [draftQuantities, setDraftQuantities] = useState<QuantityMap>({});
  const [draftClientName, setDraftClientName] = useState('');
  const offlineRequestRef = useRef(0);
  const pendingOfflinePageRef = useRef(1);
  const router = useRouter();
  const canCreateOrder = user?.role === 'admin' || user?.role === 'vendedor';
  const draftSelection = useMemo(() => countSelectedItems(draftQuantities), [draftQuantities]);
  const draftItemCount = draftSelection.distinct;
  const draftUnits = draftSelection.units;
  const draftBarVisible = canCreateOrder && draftItemCount > 0;

  // El chip del borrador y la barra inferior se apilan; los avisos globales
  // (sincronización y toast) suben para no quedar tapados por ninguno.
  useEffect(() => {
    if (!draftBarVisible) return;

    document.documentElement.dataset.catalogDraft = 'true';
    return () => {
      delete document.documentElement.dataset.catalogDraft;
    };
  }, [draftBarVisible]);

  const products = offlinePage ? offlinePage.items : initialProducts;
  const page = offlinePage ? offlinePage.page : serverPage;
  const total = offlinePage ? offlinePage.total : serverTotal;
  const totalPages = offlinePage ? offlinePage.totalPages : serverTotalPages;
  const busy = isPending || offlineLoading;

  /** Delta liviano del snapshot offline al reconectar o volver a foco. */
  const requestAutoCatalogSync = useCallback(() => {
    if (!userId || isOffline || isBrowserOffline()) return;

    void syncOfflineCatalog(userId, { auto: true }).catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.warn('No se pudo sincronizar el catálogo offline:', error);
    });
  }, [isOffline, userId]);

  useCatalogFocusRevalidation(requestAutoCatalogSync);

  /** Resuelve una página contra el snapshot local, sin tocar la red. */
  const loadLocalPage = useCallback(
    async (targetPage: number, term: string, targetBrandId: string) => {
      if (!userId) return;

      const ticket = ++offlineRequestRef.current;
      setOfflineLoading(true);

      try {
        const query = {
          brandId: targetBrandId || undefined,
          limit: PRODUCTS_PAGE_SIZE,
          offset: (targetPage - 1) * PRODUCTS_PAGE_SIZE,
        };
        let result = await searchOfflineCatalogProducts(userId, term, query);
        if (ticket !== offlineRequestRef.current) return;

        let resolvedPage = targetPage;
        let resolvedTotalPages = Math.max(1, Math.ceil(result.total / PRODUCTS_PAGE_SIZE));

        // Una URL vieja puede apuntar a una página que ya no existe en el
        // snapshot; se muestra la última disponible.
        if (targetPage > resolvedTotalPages) {
          resolvedPage = resolvedTotalPages;
          result = await searchOfflineCatalogProducts(userId, term, {
            ...query,
            offset: (resolvedPage - 1) * PRODUCTS_PAGE_SIZE,
          });
          if (ticket !== offlineRequestRef.current) return;
          resolvedTotalPages = Math.max(1, Math.ceil(result.total / PRODUCTS_PAGE_SIZE));
        }

        setOfflinePage({
          items: result.items,
          total: result.total,
          page: resolvedPage,
          totalPages: resolvedTotalPages,
        });
      } catch (error) {
        console.error('Error consultando el catálogo guardado:', error);
      } finally {
        if (ticket === offlineRequestRef.current) setOfflineLoading(false);
      }
    },
    [userId],
  );

  // Mantiene el input alineado con la URL (atrás/adelante, refresh del server)
  // sin borrar los caracteres escritos mientras la navegación está en curso.
  const markSearchCommitted = useUrlSearchSync({
    serverValue: initialSearch,
    setValue: setSearch,
    enabled: !isOffline,
  });

  useEffect(() => {
    if (isOffline) return;
    setBrandId(brands.some((brand) => brand._id === initialBrandId) ? initialBrandId : '');
  }, [initialBrandId, brands, isOffline]);

  // Detecta la falta de red (incluso cuando navigator.onLine miente) y pasa a
  // resolver todo contra IndexedDB. Al volver la conexión se revalida el server.
  useEffect(() => {
    let cancelled = false;

    const activateOffline = () => {
      if (cancelled) return;

      // La URL manda sobre el HTML cacheado: el shell puede haberse guardado
      // con otra búsqueda, pero el pathname/query actual es el que ve el usuario.
      const params = new URLSearchParams(window.location.search);
      const nextSearch = (params.get('search') || '').trim();
      const rawBrandId = params.get('brandId') || '';
      const nextBrandId = brands.some((brand) => brand._id === rawBrandId) ? rawBrandId : '';
      const parsedPage = Number.parseInt(params.get('page') || '1', 10);

      pendingOfflinePageRef.current =
        Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      setSearch(nextSearch);
      setBrandId(nextBrandId);
      setIsOffline(true);
    };

    const checkConnection = async () => {
      if (isBrowserOffline()) {
        activateOffline();
        return;
      }

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store',
          signal: controller.signal,
        });
        // Un 401 sigue siendo red disponible; un 5xx indica que la app no puede
        // responder y conviene seguir con el snapshot local.
        if (!cancelled && response.status >= 500) activateOffline();
      } catch {
        if (!cancelled) activateOffline();
      } finally {
        window.clearTimeout(timer);
      }
    };

    const handleOffline = () => activateOffline();
    const handleOnline = () => {
      if (!navigator.onLine) return;
      setIsOffline(false);
      setOfflinePage(null);
      requestAutoCatalogSync();
      startTransition(() => router.refresh());
    };

    void checkConnection();
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      cancelled = true;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [brands, requestAutoCatalogSync, router]);

  // Búsqueda y filtro locales con debounce cuando no hay red.
  useEffect(() => {
    if (!isOffline) return;

    const targetPage = pendingOfflinePageRef.current;
    pendingOfflinePageRef.current = 1;
    const trimmed = search.trim();
    const timer = window.setTimeout(
      () => {
        void loadLocalPage(targetPage, trimmed, brandId);
      },
      trimmed ? 250 : 0,
    );

    return () => window.clearTimeout(timer);
  }, [isOffline, search, brandId, loadLocalPage]);

  // Visitar el catálogo online también precalienta el snapshot del dispositivo.
  useEffect(() => {
    if (!userId || isOffline) return;
    rememberOfflineCatalogProducts(userId, initialProducts);
    rememberOfflineCatalogBrands(userId, brands);
  }, [userId, isOffline, initialProducts, brands]);

  // La primera página del SSR no alcanza para el modo offline: después de la
  // pintura se completa el catálogo con full sync y, en visitas siguientes,
  // sólo con deltas.
  useEffect(() => {
    if (!userId || isOffline) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void syncOfflineCatalog(userId, { auto: true, signal: controller.signal }).catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        console.warn('No se pudo sincronizar el catálogo offline:', error);
      });
    }, 2_500);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [userId, isOffline]);

  // El borrador se comparte con /orders/new vía localStorage. Se relee al
  // entrar al catálogo y ante un cambio de usuario para no mezclar cuentas.
  useEffect(() => {
    if (!canCreateOrder || !userId) {
      setDraftQuantities({});
      setDraftClientName('');
      return;
    }
    const saved = loadOrderDraft(getBrowserDraftStorage(), userId);
    setDraftQuantities(saved?.quantities ?? {});
    setDraftClientName(saved?.selectedClient?.name ?? '');
  }, [canCreateOrder, userId]);

  const updateDraftProduct = useCallback(
    (productId: string, delta: number) => {
      if (!canCreateOrder || !userId) return;

      const storage = getBrowserDraftStorage();
      const nextDraft = adjustOrderDraftProduct(loadOrderDraft(storage, userId), productId, delta, {
        salesperson: user?.username,
      });

      if (!saveOrderDraft(storage, nextDraft, userId)) return;
      setDraftQuantities(nextDraft.quantities);
      setDraftClientName(nextDraft.selectedClient?.name ?? '');
    },
    [canCreateOrder, user?.username, userId],
  );

  const openDraftOrder = useCallback(() => {
    if (isOffline) {
      // Sin red, una navegación RSC fallaría; el documento completo lo sirve el
      // service worker desde PAGE_CACHE y el alta resuelve el borrador local.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/orders/new');
      return;
    }
    router.push('/orders/new');
  }, [isOffline, router]);

  // Búsqueda con debounce: con red la consulta real la hace el Server Component.
  useEffect(() => {
    if (isOffline) return;

    const trimmed = search.trim();
    if (trimmed === initialSearch) return;

    const timer = setTimeout(
      () => {
        markSearchCommitted(trimmed);
        startTransition(() => {
          router.replace(buildCatalogUrl(1, trimmed, brandId));
        });
      },
      trimmed ? 300 : 0,
    );

    return () => clearTimeout(timer);
  }, [search, initialSearch, brandId, router, isOffline, markSearchCommitted]);

  const goToPage = (targetPage: number) => {
    if (targetPage < 1 || targetPage > totalPages || targetPage === page) return;

    if (isOffline) {
      void loadLocalPage(targetPage, search.trim(), brandId);
      return;
    }

    markSearchCommitted(search);
    startTransition(() => {
      router.push(buildCatalogUrl(targetPage, search.trim(), brandId));
    });
  };

  const handleBrandChange = (nextBrandId: string) => {
    if (nextBrandId === brandId) return;

    setBrandId(nextBrandId);
    if (isOffline) return;

    markSearchCommitted(search);
    startTransition(() => {
      router.replace(buildCatalogUrl(1, search.trim(), nextBrandId));
    });
  };

  const hasFilters = Boolean(search.trim() || brandId);
  const emptyMessage = search.trim()
    ? 'No se encontraron productos que coincidan con la búsqueda.'
    : brandId
      ? 'No hay productos para la marca seleccionada.'
      : busy
        ? 'Cargando productos...'
        : isOffline
          ? 'No hay productos guardados en este dispositivo.'
          : 'No hay productos disponibles en el catálogo.';

  return (
    <AppShell
      role={role}
      username={username}
      pageTitle="Catálogo"
      pageDescription="Productos, marcas y precios vigentes."
      bottomClearance={draftBarVisible ? 'extra' : 'default'}
    >
      <CatalogTabs active="products" />
      <OfflineCatalogSyncProgress className="mb-4" />
      {isOffline && <OfflineCatalogBadge className="mb-4" detail="catálogo de productos" />}
      <Card className="flex flex-col">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-action-soft p-3 text-action-text">
              <BookOpen className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Catálogo de Productos</h2>
              <p className="text-xs text-muted">
                {hasFilters
                  ? `Mostrando ${products.length} de ${total} productos`
                  : `Total de productos: ${total}`}{' '}
                · {brands.length} marcas
              </p>
            </div>
          </div>
          {canCreateOrder ? (
            draftItemCount > 0 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={openDraftOrder}
                className="shrink-0"
              >
                <ShoppingCart className="h-3.5 w-3.5" aria-hidden="true" />
                {draftItemCount} en el borrador
              </Button>
            ) : (
              <span className="rounded-full bg-action-soft px-3 py-1 text-xs font-medium text-action-text">
                Sumá productos con «+ Pedido»
              </span>
            )
          ) : (
            <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-muted">
              Solo lectura
            </span>
          )}
        </div>

        <div className="relative mb-4">
          <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-subtle">
            <Search className="h-4 w-4" aria-hidden="true" />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por código o nombre..."
            aria-label="Buscar productos por código o nombre"
            className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-12 text-base text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Limpiar búsqueda de productos"
              title="Limpiar búsqueda"
              className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <FilterChips
          ariaLabel="Filtrar por marca"
          value={brandId}
          onChange={handleBrandChange}
          className="mb-4"
          items={[
            { value: '', label: 'Todas' },
            ...brands.map((brand) => ({ value: brand._id, label: brand.name })),
          ]}
        />

        <div
          className={`flex-1 transition-opacity ${busy ? 'opacity-60' : 'opacity-100'}`}
          aria-busy={busy}
        >
          {/* En mobile cada producto se lee como tarjeta, sin tabla apretada. */}
          <div data-testid="catalog-product-cards" className="block space-y-3 sm:hidden">
            {products.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted">{emptyMessage}</div>
            ) : (
              products.map((product) => {
                const quantity = draftQuantities[product._id] ?? 0;

                return (
                  <div
                    key={`mob-${product._id}`}
                    className="cv-list-item cv-product-card rounded-lg border border-border bg-surface-muted p-3"
                  >
                    <div className="flex items-start gap-3">
                      <ProductThumbnail
                        src={product.imageUrl}
                        alt={product.name}
                        size={48}
                        className="shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-mono text-xs text-subtle">{product.code}</span>
                          <span className="text-xs font-medium text-muted">
                            {product.brandId?.name || 'N/A'}
                          </span>
                        </div>
                        <p className="mt-0.5 break-words text-sm font-semibold text-foreground">
                          {product.name}
                        </p>
                        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                          <span className="text-sm font-semibold tabular-nums text-foreground">
                            ${product.price.toFixed(2)}
                            <span className="ml-1 text-[11px] font-normal text-subtle">s/IVA</span>
                          </span>
                          <span className="text-sm font-medium tabular-nums text-muted">
                            ${(product.priceWithIva || product.price * 1.21).toFixed(2)}
                            <span className="ml-1 text-[11px] font-normal text-subtle">c/IVA</span>
                          </span>
                        </div>
                      </div>
                    </div>

                    {canCreateOrder && (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                        <span className="text-xs font-medium text-muted">
                          {quantity > 0 ? 'En el pedido' : 'Agregar al pedido'}
                        </span>
                        <DraftProductControls
                          product={product}
                          quantity={quantity}
                          onDelta={updateDraftProduct}
                        />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="hidden sm:block">
            <Table dense>
              <TableHead>
                <TableHeaderRow>
                  <TableHeaderCell>Código</TableHeaderCell>
                  <TableHeaderCell>Producto</TableHeaderCell>
                  <TableHeaderCell>Marca</TableHeaderCell>
                  <TableHeaderCell align="right">Precio s/IVA</TableHeaderCell>
                  <TableHeaderCell align="right">Precio c/IVA</TableHeaderCell>
                  {canCreateOrder && <TableHeaderCell align="right">Pedido</TableHeaderCell>}
                </TableHeaderRow>
              </TableHead>
              <TableBody>
                {products.length === 0 ? (
                  <TableEmptyRow colSpan={canCreateOrder ? 6 : 5}>{emptyMessage}</TableEmptyRow>
                ) : (
                  products.map((product) => {
                    const quantity = draftQuantities[product._id] ?? 0;

                    return (
                      <TableRow key={product._id} hover>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-muted">
                          {product.code}
                        </TableCell>
                        <TableCell className="text-foreground">{product.name}</TableCell>
                        <TableCell className="font-medium text-muted">
                          {product.brandId?.name || 'N/A'}
                        </TableCell>
                        <TableCell
                          align="right"
                          className="font-semibold tabular-nums text-foreground"
                        >
                          ${product.price.toFixed(2)}
                        </TableCell>
                        <TableCell align="right" className="font-medium tabular-nums text-muted">
                          ${(product.priceWithIva || product.price * 1.21).toFixed(2)}
                        </TableCell>
                        {canCreateOrder && (
                          <TableCell align="right">
                            <DraftProductControls
                              product={product}
                              quantity={quantity}
                              onDelta={updateDraftProduct}
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || busy}
              className="gap-1"
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
              disabled={page >= totalPages || busy}
              className="gap-1"
            >
              Siguiente <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        )}
      </Card>

      {draftBarVisible && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4 pb-4 md:bottom-0 md:pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={openDraftOrder}
            data-testid="catalog-draft-chip"
            className="pointer-events-auto w-full min-w-0 max-w-md rounded-full shadow-elevation-2"
          >
            <ShoppingCart className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 leading-snug">
              Pedido en borrador: {draftItemCount} ítems ({draftUnits} u.)
              {draftClientName ? ` · ${draftClientName}` : ''} · Ir al pedido
            </span>
          </Button>
        </div>
      )}
    </AppShell>
  );
}
