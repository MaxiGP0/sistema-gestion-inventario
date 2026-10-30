'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collectMissingProductIds,
  countSelectedItems,
  getSelectedCatalogProducts,
  groupProductsByBrand,
  SELECTED_PRODUCTS_FILTER,
  type BrandProductGroup,
  type OrderCatalogBrand,
  type OrderCatalogProduct,
  type QuantityMap,
} from '@/lib/order-catalog';
import { isAbortError } from '@/lib/api-client';
import { getCatalog } from '@/lib/catalog-query-cache';
import {
  readOfflineCatalogProductsByIds,
  searchOfflineCatalogProducts,
} from '@/lib/offline-catalog';
import { isBrowserOffline, rememberOfflineCatalogProducts } from '@/lib/offline-catalog-sync';
import { useCatalogFocusRevalidation } from '@/hooks/useCatalogFocusRevalidation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import type { ProductDTO, ProductListResponse } from '@/lib/types';

export const PRODUCTS_PAGE_SIZE = 50;

/** Índice de productos por id para calcular el carrito sin perder los ya vistos. */
export function buildInitialProductCache(
  products: OrderCatalogProduct[],
): Record<string, OrderCatalogProduct> {
  const cache: Record<string, OrderCatalogProduct> = {};
  for (const product of products) cache[product._id] = product;
  return cache;
}

/** La vista base del catálogo es "Todas las marcas" sin texto de búsqueda. */
export function isBaseCatalogView(selectedBrandFilter: string, searchTerm: string): boolean {
  return selectedBrandFilter === 'ALL' && searchTerm.trim() === '';
}

/** `true` si la primera página del servidor deja productos para "Cargar más". */
export function getInitialHasMoreProducts(
  total: number,
  pageSize: number = PRODUCTS_PAGE_SIZE,
): boolean {
  return pageSize < total;
}

interface UseOrderCatalogOptions {
  brands: OrderCatalogBrand[];
  /** Cantidades del carrito: se usan para recuperar productos de un borrador. */
  quantities: QuantityMap;
  /** Dueño del snapshot offline; nunca se comparte entre usuarios. */
  userId: string;
  pageSize?: number;
  /** Primera página resuelta en el servidor para no abrir el alta vacía. */
  initialProducts?: ProductDTO[];
  /** Total de productos del catálogo; habilita "Cargar más" desde el inicio. */
  initialProductsTotal?: number;
}

export interface OrderCatalogState {
  products: OrderCatalogProduct[];
  productsByBrand: BrandProductGroup[];
  productCache: Record<string, OrderCatalogProduct>;
  productsTotal: number;
  loadingProducts: boolean;
  hasMoreProducts: boolean;
  hasCatalogFilter: boolean;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  selectedBrandFilter: string;
  setSelectedBrandFilter: (value: string) => void;
  loadMoreProducts: () => void;
  /** La página visible salió de IndexedDB (sin red o fallback). */
  catalogFromCache: boolean;
}

/**
 * Catálogo paginado del alta de pedidos: búsqueda y filtro por marca con
 * debounce, carga incremental y caché en memoria de los productos usados.
 *
 * La vista base ("Todas las marcas" sin búsqueda) muestra la primera página que
 * resolvió el servidor en el primer HTML; los filtros y la búsqueda siguen
 * consultando al servidor. Con el snapshot offline, esa misma vista y las
 * búsquedas se resuelven localmente cuando `navigator.onLine` es false o la red
 * falla.
 */
export function useOrderCatalog({
  brands,
  quantities,
  userId,
  pageSize = PRODUCTS_PAGE_SIZE,
  initialProducts = [],
  initialProductsTotal = initialProducts.length,
}: UseOrderCatalogOptions): OrderCatalogState {
  const [products, setProducts] = useState<OrderCatalogProduct[]>(initialProducts);
  const [productPage, setProductPage] = useState(1);
  const [productsTotal, setProductsTotal] = useState(initialProductsTotal);
  const [hasMoreProducts, setHasMoreProducts] = useState(() =>
    getInitialHasMoreProducts(initialProductsTotal, pageSize),
  );
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productCache, setProductCache] = useState<Record<string, OrderCatalogProduct>>(() =>
    buildInitialProductCache(initialProducts),
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBrandFilter, setSelectedBrandFilter] = useState('ALL');
  const [catalogFromCache, setCatalogFromCache] = useState(false);

  const requestedMissingIdsRef = useRef<Set<string>>(new Set());
  const productsRequest = useLatestRequest();
  const missingProductsRequest = useLatestRequest();

  const applyIncomingPage = useCallback(
    (
      incoming: OrderCatalogProduct[],
      targetPage: number,
      total: number,
      append: boolean,
      fromCache: boolean,
    ) => {
      setProducts((prev) => {
        if (!append) return incoming;
        const seen = new Set(prev.map((item) => item._id));
        return [...prev, ...incoming.filter((item) => !seen.has(item._id))];
      });
      setProductPage(targetPage);
      setProductsTotal(total);
      setHasMoreProducts(targetPage * pageSize < total);
      setCatalogFromCache(fromCache);

      // Acumular en caché: permite calcular el carrito aunque el producto
      // ya no esté visible en la página actual.
      setProductCache((prev) => {
        const next = { ...prev };
        for (const product of incoming) next[product._id] = product;
        return next;
      });
    },
    [pageSize],
  );

  const loadLocalProductsPage = useCallback(
    async (
      targetPage: number,
      searchValue: string,
      brandFilter: string,
      append: boolean,
    ): Promise<boolean> => {
      try {
        const snapshot = await searchOfflineCatalogProducts(userId, searchValue, {
          brandId: brandFilter && brandFilter !== 'ALL' ? brandFilter : undefined,
          limit: pageSize,
          offset: (targetPage - 1) * pageSize,
        });

        applyIncomingPage(
          snapshot.items as OrderCatalogProduct[],
          targetPage,
          snapshot.total,
          append,
          true,
        );
        return snapshot.items.length > 0 || snapshot.total > 0;
      } catch (error) {
        console.error('Error buscando productos guardados:', error);
        return false;
      }
    },
    [applyIncomingPage, pageSize, userId],
  );

  const fetchProductsPage = useCallback(
    async (
      targetPage: number,
      searchValue: string,
      brandFilter: string,
      append: boolean,
      force = false,
    ) => {
      const ticket = productsRequest.start();
      setLoadingProducts(true);

      // Sin red ni siquiera se intenta el fetch: se busca en IndexedDB.
      if (isBrowserOffline()) {
        const found = await loadLocalProductsPage(targetPage, searchValue, brandFilter, append);
        if (productsRequest.isCurrent(ticket)) {
          if (!found) applyIncomingPage([], targetPage, 0, append, true);
          setLoadingProducts(false);
        }
        return;
      }

      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          limit: String(pageSize),
        });
        if (searchValue.trim()) params.set('search', searchValue.trim());
        if (brandFilter && brandFilter !== 'ALL') params.set('brandId', brandFilter);

        const data = await getCatalog<ProductListResponse>(`/api/products?${params.toString()}`, {
          signal: ticket.signal,
          force,
        });

        // Descartar respuestas obsoletas o canceladas (segunda barrera: id).
        if (!productsRequest.isCurrent(ticket)) return;

        applyIncomingPage(
          data.products as OrderCatalogProduct[],
          data.page,
          data.total,
          append,
          false,
        );
        rememberOfflineCatalogProducts(userId, data.products);
      } catch (err) {
        if (isAbortError(err) || !productsRequest.isCurrent(ticket)) return;

        // Red caída con `navigator.onLine` todavía en true (Wi-Fi sin salida,
        // timeout del servidor): se degrada al snapshot local con aviso.
        const found = await loadLocalProductsPage(targetPage, searchValue, brandFilter, append);
        if (productsRequest.isCurrent(ticket)) {
          if (!found) applyIncomingPage([], targetPage, 0, append, true);
          console.error('Error cargando productos:', err);
        }
      } finally {
        if (productsRequest.isCurrent(ticket)) setLoadingProducts(false);
      }
    },
    [applyIncomingPage, loadLocalProductsPage, pageSize, productsRequest, userId],
  );

  // El HTML del servidor ya trae la primera página: se guarda en el snapshot
  // offline apenas monta y sirve de caché inmediata para el carrito.
  useEffect(() => {
    if (!userId) return;
    rememberOfflineCatalogProducts(userId, initialProducts);
  }, [initialProducts, userId]);

  // Búsqueda y filtro por marca con debounce contra el servidor.
  useEffect(() => {
    // "Seleccionados" se resuelve en memoria con `productCache`: no hay fetch
    // de catálogo ni paginación que hacer.
    if (selectedBrandFilter === SELECTED_PRODUCTS_FILTER) {
      productsRequest.abort();
      setLoadingProducts(false);
      return;
    }

    const trimmedSearch = searchTerm.trim();
    const hasFilter = !isBaseCatalogView(selectedBrandFilter, searchTerm);

    if (!hasFilter) {
      // Sin filtros se vuelve a la primera página que ya vino del servidor (o
      // al snapshot local si el shell se sirvió sin productos y no hay red).
      productsRequest.abort();
      setLoadingProducts(false);
      if (isBrowserOffline()) {
        if (initialProducts.length > 0) {
          applyIncomingPage(initialProducts, 1, initialProductsTotal, false, true);
        } else {
          void loadLocalProductsPage(1, '', 'ALL', false);
        }
      } else {
        applyIncomingPage(initialProducts, 1, initialProductsTotal, false, false);
      }
      return;
    }

    const timer = setTimeout(
      () => {
        void fetchProductsPage(1, searchTerm, selectedBrandFilter, false);
      },
      trimmedSearch ? 300 : 0,
    );
    return () => {
      // Cambió el filtro o se desmontó: cancelar la consulta anterior ya.
      clearTimeout(timer);
      productsRequest.abort();
    };
  }, [
    searchTerm,
    selectedBrandFilter,
    applyIncomingPage,
    fetchProductsPage,
    initialProducts,
    initialProductsTotal,
    loadLocalProductsPage,
    productsRequest,
  ]);

  // Al pasar a offline se reintenta la vista vigente contra IndexedDB (también
  // la primera página sin filtros); al volver la conexión se revalida en red.
  useEffect(() => {
    const selectedFilterActive = selectedBrandFilter === SELECTED_PRODUCTS_FILTER;

    const handleOffline = () => {
      if (selectedFilterActive) return;
      void fetchProductsPage(1, searchTerm, selectedBrandFilter, false);
    };
    const handleOnline = () => {
      if (selectedFilterActive) return;
      void fetchProductsPage(1, searchTerm, selectedBrandFilter, false, true);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [fetchProductsPage, searchTerm, selectedBrandFilter]);

  const fetchProductsByIds = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;

      const ticket = missingProductsRequest.start();

      if (isBrowserOffline()) {
        const cached = await readOfflineCatalogProductsByIds(userId, ids);
        if (!missingProductsRequest.isCurrent(ticket)) return;
        setProductCache((prev) => {
          const next = { ...prev };
          for (const product of cached) next[product._id] = product as OrderCatalogProduct;
          return next;
        });
        return;
      }

      try {
        const params = new URLSearchParams({ ids: ids.slice(0, 200).join(','), limit: '200' });
        const data = await getCatalog<ProductListResponse>(`/api/products?${params.toString()}`, {
          signal: ticket.signal,
        });
        if (!missingProductsRequest.isCurrent(ticket)) return;

        setProductCache((prev) => {
          const next = { ...prev };
          for (const product of data.products) next[product._id] = product;
          return next;
        });
        rememberOfflineCatalogProducts(userId, data.products);
      } catch (err) {
        // Red caída: completar el carrito con el snapshot local antes de
        // liberar los ids. Si tampoco está local, se libera para reintentar.
        const cached = await readOfflineCatalogProductsByIds(userId, ids);
        if (cached.length > 0) {
          setProductCache((prev) => {
            const next = { ...prev };
            for (const product of cached) next[product._id] = product as OrderCatalogProduct;
            return next;
          });
        } else {
          ids.forEach((id) => requestedMissingIdsRef.current.delete(id));
        }
        if (isAbortError(err) || !missingProductsRequest.isCurrent(ticket)) return;
        console.error('Error recuperando productos del carrito:', err);
      }
    },
    [missingProductsRequest, userId],
  );

  // Recuperar del servidor productos del carrito que no estén en memoria
  // (por ejemplo, un borrador restaurado después de recargar la página).
  useEffect(() => {
    const requestedIds = requestedMissingIdsRef.current;
    const missing = collectMissingProductIds(quantities, productCache, requestedIds);
    if (missing.length === 0) return;

    missing.forEach((id) => requestedIds.add(id));
    void fetchProductsByIds(missing);

    return () => {
      missingProductsRequest.abort();
      missing.forEach((id) => requestedIds.delete(id));
    };
  }, [quantities, productCache, fetchProductsByIds, missingProductsRequest]);

  // Al volver a foco se invalida la caché y se refrescan la búsqueda actual y
  // los productos del carrito (sus precios/descuentos pueden haber cambiado).
  useCatalogFocusRevalidation(
    useCallback(() => {
      if (selectedBrandFilter === SELECTED_PRODUCTS_FILTER) {
        void fetchProductsByIds(Object.keys(quantities));
        return;
      }
      // Si el usuario ya cargó más de una página, refrescar sólo la primera la
      // haría retroceder; en ese caso se respeta la vista incremental.
      if (isBaseCatalogView(selectedBrandFilter, searchTerm) && productPage > 1) {
        void fetchProductsByIds(Object.keys(quantities));
        return;
      }
      void fetchProductsPage(1, searchTerm, selectedBrandFilter, false);
      void fetchProductsByIds(Object.keys(quantities));
    }, [
      fetchProductsByIds,
      fetchProductsPage,
      productPage,
      quantities,
      searchTerm,
      selectedBrandFilter,
    ]),
  );

  const brandNameById = useMemo(() => {
    const map = new Map<string, string>();
    brands.forEach((brand) => map.set(brand._id, brand.name));
    return map;
  }, [brands]);

  const selectedProducts = useMemo(
    () => getSelectedCatalogProducts(quantities, productCache),
    [quantities, productCache],
  );
  const selectedFilterActive = selectedBrandFilter === SELECTED_PRODUCTS_FILTER;
  const selectedDistinct = useMemo(() => countSelectedItems(quantities).distinct, [quantities]);

  // Si el carrito queda vacío mientras se ve "Seleccionados", volver a la
  // vista normal evita dejar al usuario en una pantalla sin resultados.
  useEffect(() => {
    if (selectedFilterActive && selectedDistinct === 0) {
      setSelectedBrandFilter('ALL');
    }
  }, [selectedFilterActive, selectedDistinct]);

  const visibleProducts = selectedFilterActive ? selectedProducts : products;
  const productsByBrand = useMemo(
    () => groupProductsByBrand(visibleProducts, brandNameById),
    [visibleProducts, brandNameById],
  );

  const hasCatalogFilter = searchTerm.trim() !== '' || selectedBrandFilter !== 'ALL';

  const loadMoreProducts = useCallback(() => {
    if (selectedFilterActive || loadingProducts || !hasMoreProducts) return;
    fetchProductsPage(productPage + 1, searchTerm, selectedBrandFilter, true);
  }, [
    fetchProductsPage,
    loadingProducts,
    hasMoreProducts,
    productPage,
    searchTerm,
    selectedBrandFilter,
    selectedFilterActive,
  ]);

  return {
    products: visibleProducts,
    productsByBrand,
    productCache,
    productsTotal: selectedFilterActive ? selectedProducts.length : productsTotal,
    // Mientras faltan productos del borrador en la caché, la vista de
    // seleccionados muestra una carga en lugar de un falso "sin resultados".
    loadingProducts: selectedFilterActive
      ? selectedDistinct > selectedProducts.length
      : loadingProducts,
    hasMoreProducts: selectedFilterActive ? false : hasMoreProducts,
    hasCatalogFilter,
    searchTerm,
    setSearchTerm,
    selectedBrandFilter,
    setSelectedBrandFilter,
    loadMoreProducts,
    catalogFromCache,
  };
}
