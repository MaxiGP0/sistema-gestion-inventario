'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/app-shell/AppShell';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/context/ToastContext';
import { useOrderCatalog } from '@/hooks/useOrderCatalog';
import { useOrderDraft } from '@/hooks/useOrderDraft';
import { useCatalogFocusRevalidation } from '@/hooks/useCatalogFocusRevalidation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { useMobileKeyboardFocus } from '@/hooks/useVisualViewport';
import Card from '@/components/ui/Card';
import OrderCatalog from '@/components/orders/new/OrderCatalog';
import OfflineCatalogBadge from '@/components/orders/new/OfflineCatalogBadge';
import OfflinePendingBanner from '@/components/orders/new/OfflinePendingBanner';
import MobileClientPanel from '@/components/orders/new/MobileClientPanel';
import ClientPanel from '@/components/orders/new/ClientPanel';
import OrderSummaryPanel from '@/components/orders/new/OrderSummaryPanel';
import MobileActionBar from '@/components/orders/new/MobileActionBar';
import type { ClientDetailsStateProps } from '@/components/orders/new/SelectedClientDetails';
import type { UserRole } from '@/lib/authz';
import {
  resolveCommercialDefaultsFromLastOrder,
  type InvoiceType,
  type PaymentCondition,
} from '@/lib/order-commercial';
import {
  applyQuantityDelta,
  buildOrderItems,
  calculateOrderTotals,
  countSelectedItems,
  getClientDiscounts,
  parseDiscountInput,
  parseGeneralDiscount,
  parseQuantityInput,
  SELECTED_PRODUCTS_FILTER,
  type DiscountMap,
  type OrderCatalogBrand,
  type OrderCatalogClient,
} from '@/lib/order-catalog';
import { api, ApiClientError, isAbortError, isNetworkError } from '@/lib/api-client';
import { getCatalog, invalidateCatalogCache } from '@/lib/catalog-query-cache';
import { applyClientToOrderDraft } from '@/lib/order-draft';
import {
  readOfflineCatalogBrands,
  readOfflineCatalogClients,
  readOfflineRecentClients,
  recordOfflineRecentClient,
  searchOfflineCatalogClients,
} from '@/lib/offline-catalog';
import {
  cacheInitialOfflineCatalog,
  isBrowserOffline,
  prefetchOfflineCatalogClients,
  prefetchOfflineCatalogProducts,
  rememberOfflineCatalogBrands,
  rememberOfflineCatalogClients,
} from '@/lib/offline-catalog-sync';
import {
  enqueuePendingOrderCreate,
  getPendingOrderRequests,
  OFFLINE_QUEUE_CHANGED_EVENT,
} from '@/lib/offline-order-queue';
import { createClientRequestId } from '@/lib/order-request-id';
import { requestOrderBackgroundSync } from '@/lib/order-put-sync';
import { isRetriableOrderPutStatus } from '@/lib/order-put-sync-core';
import { buildOrderPrefill, buildPrefillOmittedMessage } from '@/lib/order-prefill';
import { markOrdersTrayForRefresh } from '@/lib/orders-tray-refresh';
import type {
  BrandListResponse,
  ClientDetailResponse,
  ClientDTO,
  ClientListResponse,
  OrderCursorListResponse,
  OrderDTO,
  OrderDetailResponse,
  OrderMutationResponse,
  OrderSummaryDTO,
  ProductDTO,
} from '@/lib/types';

/**
 * Los modales móviles se descargan recién al abrirlos: no forman parte del
 * bundle inicial del alta. El estado de apertura vive en este componente, así
 * que el import dinámico se dispara con el primer toque.
 */
const MobileClientModal = dynamic(() => import('@/components/orders/new/MobileClientModal'), {
  ssr: false,
  loading: () => null,
});

const MobileCheckoutModal = dynamic(() => import('@/components/orders/new/MobileCheckoutModal'), {
  ssr: false,
  loading: () => null,
});

const QuickCreateClientModal = dynamic(
  () => import('@/components/orders/new/QuickCreateClientModal'),
  {
    ssr: false,
    loading: () => null,
  },
);

interface NewOrderClientProps {
  initialBrands: OrderCatalogBrand[];
  initialClients: OrderCatalogClient[];
  /** Primera página del catálogo resuelta en el servidor. */
  initialProducts: ProductDTO[];
  initialProductsTotal: number;
  /** Usuario de la sesión resuelta en el servidor. Nunca sale de localStorage. */
  salesperson: string;
  /** Dueño del borrador y de la cola offline, también de la sesión server-side. */
  userId: string;
  /** Rol de la sesión para la navegación del AppShell. */
  role: UserRole;
  /**
   * `edit` reutiliza el formulario para ajustar un borrador propio y guarda con
   * `PUT /api/orders/[id]` (mode `draft-edit`). `create` da de alta uno nuevo.
   */
  mode?: 'create' | 'edit';
  /** Pedido ya resuelto en el servidor para precargar el carrito. */
  initialOrder?: OrderDTO | null;
  /** `?fromOrder=`: si el servidor no pudo resolverlo, se reintenta en cliente. */
  fromOrderId?: string;
  /** Cliente ya resuelto para `?clientId=`. */
  initialClient?: OrderCatalogClient | null;
  /** `?clientId=`: identifica el intento para no repetir el aviso de error. */
  initialClientId?: string;
  /** Destino explícito de "Volver" (la edición apunta al detalle del pedido). */
  backHref?: string;
}

export default function NewOrderClient({
  initialBrands,
  initialClients,
  initialProducts,
  initialProductsTotal,
  salesperson,
  userId,
  role,
  mode = 'create',
  initialOrder = null,
  fromOrderId,
  initialClient = null,
  initialClientId,
  backHref: backHrefProp,
}: NewOrderClientProps) {
  const isEditMode = mode === 'edit';
  // "Volver" no depende del historial: la edición regresa a su detalle y el
  // alta a la bandeja, nunca al formulario anterior.
  const backHref =
    backHrefProp ?? (isEditMode && initialOrder ? `/orders/${initialOrder._id}` : '/orders');
  // El HTML cacheado por el SW puede haberse guardado sin query o con otro
  // cliente; la URL actual siempre manda para resolver `?clientId=`.
  const requestedClientId =
    initialClientId ||
    (typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('clientId')?.trim() || undefined
      : undefined);
  // El cliente resuelto en el servidor sólo sirve si coincide con la URL. Si no,
  // el efecto de precarga lo busca en initialClients, la API o IndexedDB.
  const prefilledClient =
    initialClient && (!requestedClientId || initialClient._id === requestedClientId)
      ? initialClient
      : null;
  // Con una precarga explícita (repetir/editar) el borrador local no debe
  // pisar el carrito que viene del pedido ni guardarse como si fuera un alta.
  const hasPrefillSource = Boolean(initialOrder || fromOrderId || requestedClientId);
  const [clients, setClients] = useState<OrderCatalogClient[]>(initialClients);
  const [brands, setBrands] = useState<OrderCatalogBrand[]>(initialBrands);
  const [recentClients, setRecentClients] = useState<OrderCatalogClient[]>([]);
  const [offlineCatalogNotice, setOfflineCatalogNotice] = useState(false);
  const [selectedClient, setSelectedClient] = useState<OrderCatalogClient | null>(null);
  const [clientSearch, setClientSearch] = useState('');
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const [lastOrder, setLastOrder] = useState<OrderSummaryDTO | null>(null);
  const [lastOrderClientId, setLastOrderClientId] = useState<string | null>(null);
  const [loadingLastOrder, setLoadingLastOrder] = useState(false);
  const [repeatConfirm, setRepeatConfirm] = useState<{
    orderId: string;
    clientName: string;
  } | null>(null);

  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [itemDiscounts, setItemDiscounts] = useState<DiscountMap>({});

  const [generalDiscount, setGeneralDiscount] = useState(0);
  const [brandDiscounts, setBrandDiscounts] = useState<DiscountMap>({});
  const [showBrandDiscountsPanel, setShowBrandDiscountsPanel] = useState(false);

  const [comment, setComment] = useState('');
  const [invoiceType, setInvoiceType] = useState<InvoiceType | ''>('');
  const [paymentCondition, setPaymentCondition] = useState<PaymentCondition | ''>('');
  const [paymentConditionDetail, setPaymentConditionDetail] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingSyncRequestId, setPendingSyncRequestId] = useState<string | null>(null);
  const [showMobileCheckoutModal, setShowMobileCheckoutModal] = useState(false);
  const [showMobileClientModal, setShowMobileClientModal] = useState(false);
  const [showQuickCreateClientModal, setShowQuickCreateClientModal] = useState(false);

  const submittingRef = useRef(false);
  const hydratedCatalogOwnerRef = useRef<string | null>(null);
  // El autocompletado comercial sólo pisa campos vacíos que el vendedor no
  // haya elegido a mano en este pedido (aunque después los haya limpiado).
  const invoiceTypeTouchedRef = useRef(false);
  const paymentConditionTouchedRef = useRef(false);
  // Evita reaplicar la precarga en el doble montaje de StrictMode o en renders
  // posteriores mientras el vendedor ya está editando el carrito.
  const appliedPrefillRef = useRef<string | null>(null);
  // Cliente resuelto para `?clientId=` que debe combinarse con el borrador
  // restaurado sin perder las cantidades cargadas desde el catálogo.
  const pendingDraftClientRef = useRef<OrderCatalogClient | null>(null);
  // La limpieza de la URL se hace una sola vez por visita.
  const cleanedPrefillUrlRef = useRef(false);
  // El borrador sólo se restaura en un alta sin pedido precargado: con
  // `?fromOrder=` el carrito del pedido es la fuente de verdad. Se fija al
  // montar para que el `router.replace` posterior no vuelva a restaurarlo.
  const [shouldRestoreDraft] = useState(() => !isEditMode && !initialOrder && !fromOrderId);
  // El autoguardado recién se habilita cuando terminó la precarga inicial (o
  // cuando no había ninguna), para no persistir un carrito a medio hidratar.
  const [draftSaveReady, setDraftSaveReady] = useState(!hasPrefillSource);
  const clientSearchRequest = useLatestRequest();
  // Última lista completa (50 clientes) recibida del servidor o del snapshot.
  // Permite volver a mostrarla al vaciar el buscador sin repetir el fetch.
  const defaultClientsRef = useRef<OrderCatalogClient[]>(initialClients);

  const { showToast } = useToast();
  const router = useRouter();

  // Mantiene el campo enfocado sobre el teclado y oculta la barra inferior
  // mientras se escribe (sólo activo en el breakpoint móvil).
  const inputFocused = useMobileKeyboardFocus();

  // Catálogo paginado + caché en memoria de productos usados en el carrito.
  const catalog = useOrderCatalog({
    brands,
    quantities,
    userId,
    initialProducts,
    initialProductsTotal,
  });
  const { productCache, setSelectedBrandFilter: setCatalogBrandFilter } = catalog;

  const { units: totalItemsCount, distinct: distinctProductsCount } = useMemo(
    () => countSelectedItems(quantities),
    [quantities],
  );

  const draft = useMemo(
    () => ({
      quantities,
      selectedClient,
      salesperson,
      comment,
      itemDiscounts,
      generalDiscount,
      brandDiscounts,
      invoiceType,
      paymentCondition,
      paymentConditionDetail,
    }),
    [
      quantities,
      selectedClient,
      salesperson,
      comment,
      itemDiscounts,
      generalDiscount,
      brandDiscounts,
      invoiceType,
      paymentCondition,
      paymentConditionDetail,
    ],
  );

  const { clearDraft } = useOrderDraft({
    draft,
    userId,
    enabled: !isEditMode && draftSaveReady,
    restore: shouldRestoreDraft,
    onRestore: (saved) => {
      // Si la visita trae `?clientId=`, el borrador aporta el carrito y los
      // datos comerciales, pero el cliente (y sus descuentos base) siempre es
      // el solicitado en la URL.
      const prefillClient = pendingDraftClientRef.current;
      const restored = prefillClient ? applyClientToOrderDraft(saved, prefillClient) : saved;
      pendingDraftClientRef.current = null;

      setQuantities(restored.quantities);
      setSelectedClient(restored.selectedClient);
      setComment(restored.comment);
      setItemDiscounts(restored.itemDiscounts);
      setGeneralDiscount(restored.generalDiscount);
      setBrandDiscounts(restored.brandDiscounts);
      invoiceTypeTouchedRef.current = false;
      paymentConditionTouchedRef.current = false;
      setInvoiceType(restored.invoiceType);
      setPaymentCondition(restored.paymentCondition);
      setPaymentConditionDetail(restored.paymentConditionDetail);

      // Un borrador con productos se reabre en "Seleccionados" para que el
      // carrito no quede escondido en una pantalla vacía. Si el usuario ya
      // tenía una búsqueda o marca activa, se respeta ese filtro.
      if (
        countSelectedItems(restored.quantities).distinct > 0 &&
        !catalog.searchTerm.trim() &&
        catalog.selectedBrandFilter === 'ALL'
      ) {
        catalog.setSelectedBrandFilter(SELECTED_PRODUCTS_FILTER);
      }
    },
    onRestored: () => showToast('Borrador de pedido restaurado automáticamente', 'success'),
  });

  // El aviso local desaparece cuando el indicador global sincroniza (o
  // descarta con aviso) la entrada de esta alta.
  useEffect(() => {
    if (!pendingSyncRequestId) return;

    let active = true;
    const refresh = async () => {
      try {
        const entries = await getPendingOrderRequests();
        const queued = entries.find(
          (entry) => entry.kind === 'create' && entry.clientRequestId === pendingSyncRequestId,
        );
        // Un rechazo permanente deja de ser "pendiente": el indicador global
        // muestra el error y ofrece restaurar el borrador.
        if (active && (!queued || queued.status === 'failed')) {
          setPendingSyncRequestId(null);
        }
      } catch {
        // IndexedDB no disponible: el aviso se mantiene hasta recargar.
      }
    };

    void refresh();
    window.addEventListener(OFFLINE_QUEUE_CHANGED_EVENT, refresh);

    return () => {
      active = false;
      window.removeEventListener(OFFLINE_QUEUE_CHANGED_EVENT, refresh);
    };
  }, [pendingSyncRequestId]);

  /** Usa el snapshot local cuando no hay red o la consulta falló. */
  const loadClientsFromCache = useCallback(
    async (term: string, limit: number) => {
      const snapshot = await searchOfflineCatalogClients(userId, term, { limit });
      setClients(snapshot.items as OrderCatalogClient[]);
      if (term.trim() === '') defaultClientsRef.current = snapshot.items as OrderCatalogClient[];
      if (snapshot.total > 0 || snapshot.expired > 0) setOfflineCatalogNotice(true);
      return snapshot;
    },
    [userId],
  );

  /**
   * Revalida clientes/marcas en red. Si no hay conexión (o la red falla) cae
   * al snapshot de IndexedDB y enciende el aviso de datos guardados.
   */
  const refreshCatalog = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (isBrowserOffline()) {
        const [cachedClients, cachedBrands] = await Promise.all([
          readOfflineCatalogClients(userId),
          readOfflineCatalogBrands(userId),
        ]);

        if (cachedClients.items.length > 0) {
          defaultClientsRef.current = cachedClients.items as OrderCatalogClient[];
          setClients(cachedClients.items as OrderCatalogClient[]);
        }
        if (cachedBrands.items.length > 0) {
          setBrands(cachedBrands.items as OrderCatalogBrand[]);
        }
        if (cachedClients.items.length > 0 || cachedBrands.items.length > 0) {
          setOfflineCatalogNotice(true);
        }
        return;
      }

      try {
        const [clientsData, brandsData] = await Promise.all([
          getCatalog<ClientListResponse>('/api/clients?limit=50', { force }),
          getCatalog<BrandListResponse>('/api/brands', { force }),
        ]);

        defaultClientsRef.current = clientsData.clients;
        setClients(clientsData.clients);
        setBrands(brandsData.brands);
        setOfflineCatalogNotice(false);
        rememberOfflineCatalogClients(userId, clientsData.clients);
        rememberOfflineCatalogBrands(userId, brandsData.brands);
        // Refrescar también los descuentos del cliente ya elegido: la caché de
        // clientes es corta justamente porque afectan los precios del pedido.
        setSelectedClient((current) =>
          current
            ? (clientsData.clients.find((client) => client._id === current._id) ?? current)
            : current,
        );
      } catch (err) {
        if (isAbortError(err)) return;
        console.error('Error cargando datos:', err);
        await loadClientsFromCache('', 50);
        try {
          const cachedBrands = await readOfflineCatalogBrands(userId);
          if (cachedBrands.items.length > 0) {
            setBrands(cachedBrands.items as OrderCatalogBrand[]);
            setOfflineCatalogNotice(true);
          }
        } catch {
          // Sin IndexedDB no hay copia de respaldo.
        }
      }
    },
    [loadClientsFromCache, userId],
  );

  const searchClients = useCallback(async () => {
    // Aborta la búsqueda anterior y conserva el id para descartar respuestas
    // que ya estaban en vuelo.
    const ticket = clientSearchRequest.start();
    const term = clientSearch.trim();

    if (isBrowserOffline()) {
      try {
        await loadClientsFromCache(term, 30);
      } catch (error) {
        console.error('Error buscando clientes guardados:', error);
      }
      return;
    }

    try {
      const url = term
        ? `/api/clients?search=${encodeURIComponent(term)}&limit=30`
        : '/api/clients?limit=50';
      const data = await getCatalog<ClientListResponse>(url, { signal: ticket.signal });

      if (!clientSearchRequest.isCurrent(ticket)) return;

      setClients(data.clients);
      rememberOfflineCatalogClients(userId, data.clients);
    } catch (err) {
      if (isAbortError(err) || !clientSearchRequest.isCurrent(ticket)) return;
      console.error('Error buscando clientes:', err);
      try {
        await loadClientsFromCache(term, 30);
      } catch (cacheError) {
        console.error('Error leyendo clientes guardados:', cacheError);
      }
    }
  }, [clientSearch, clientSearchRequest, loadClientsFromCache, userId]);

  useEffect(() => {
    // Buscar también cuando el modal móvil está abierto: en el teléfono este es
    // el único buscador de clientes visible y no activa showClientDropdown.
    if (!showClientDropdown && !showMobileClientModal) {
      clientSearchRequest.abort();
      return;
    }

    // Con el buscador vacío se muestra la lista completa que ya vino del
    // servidor (o se refrescó al volver a foco): no hace falta otro fetch.
    if (!clientSearch.trim()) {
      clientSearchRequest.abort();
      setClients(defaultClientsRef.current);
      return;
    }

    const timer = setTimeout(() => {
      void searchClients();
    }, 300);

    return () => {
      clearTimeout(timer);
      // Cambió el texto, se cerró el selector o se desmontó: cancelar ya.
      clientSearchRequest.abort();
    };
  }, [clientSearch, searchClients, showClientDropdown, showMobileClientModal, clientSearchRequest]);

  /**
   * Hidratación del catálogo al montar:
   * 1. guarda en IndexedDB el snapshot que ya vino del servidor;
   * 2. lee clientes/marcas/recientes de la copia local;
   * 3. sin red usa esa copia; con red revalida en segundo plano.
   *
   * El ref evita duplicar escrituras/consultas en el doble montaje de
   * React StrictMode sin bloquear un cambio real de usuario.
   */
  useEffect(() => {
    if (hydratedCatalogOwnerRef.current === userId) return;
    hydratedCatalogOwnerRef.current = userId;
    let cancelled = false;
    let finished = false;

    const hydrate = async () => {
      try {
        await cacheInitialOfflineCatalog(userId, {
          clients: initialClients,
          brands: initialBrands,
        });

        const [cachedClients, cachedBrands, recent] = await Promise.all([
          readOfflineCatalogClients(userId),
          readOfflineCatalogBrands(userId),
          readOfflineRecentClients(userId),
        ]);
        if (cancelled) return;

        setRecentClients(recent.items as OrderCatalogClient[]);

        const offline = isBrowserOffline();
        if ((offline || initialClients.length === 0) && cachedClients.items.length > 0) {
          const cached = cachedClients.items as OrderCatalogClient[];
          defaultClientsRef.current = cached;
          setClients(cached);
        }
        if ((offline || initialBrands.length === 0) && cachedBrands.items.length > 0) {
          setBrands(cachedBrands.items as OrderCatalogBrand[]);
        }

        if (offline) {
          if (cachedClients.items.length > 0 || cachedBrands.items.length > 0) {
            setOfflineCatalogNotice(true);
          }
          return;
        }

        // El Server Component ya resolvió clientes y marcas en el primer HTML:
        // no se repiten esos GET al montar. La revalidación por foco, el evento
        // `online` y el shell sin datos iniciales siguen consultando la red.
        if (initialClients.length === 0 || initialBrands.length === 0) {
          await refreshCatalog({ force: true });
        }
      } catch (error) {
        console.error('Error hidratando el catálogo offline:', error);
        if (!cancelled && !isBrowserOffline()) void refreshCatalog({ force: true });
      } finally {
        finished = true;
      }
    };

    void hydrate();

    return () => {
      cancelled = true;
      // StrictMode monta, limpia y vuelve a montar el efecto en desarrollo. Si
      // la hidratación todavía no terminó, se libera la marca para que el
      // segundo montaje haga el trabajo completo (incluida la revalidación).
      if (!finished) hydratedCatalogOwnerRef.current = null;
    };
  }, [initialBrands, initialClients, refreshCatalog, userId]);

  // Precalienta productos y clientes después de la primera pintura: el buscador
  // offline necesita el catálogo completo aunque el vendedor nunca haya abierto
  // esas pantallas en esta sesión. El TTL evita repetirlo en cada visita.
  useEffect(() => {
    if (!userId) return;

    const timer = window.setTimeout(() => {
      if (isBrowserOffline()) return;
      void prefetchOfflineCatalogProducts(userId).catch((error) => {
        console.warn('No se pudo precargar el catálogo de productos offline:', error);
      });
      void prefetchOfflineCatalogClients(userId).catch((error) => {
        console.warn('No se pudo precargar el catálogo de clientes offline:', error);
      });
    }, 2_500);

    return () => window.clearTimeout(timer);
  }, [userId]);

  // Al recuperar conexión se revalida el catálogo guardado. Al perderla, el
  // aviso aparece de inmediato si hay datos visibles para seguir trabajando.
  useEffect(() => {
    const handleOnline = () => {
      void refreshCatalog({ force: true });
      if ((showClientDropdown || showMobileClientModal) && clientSearch.trim()) {
        void searchClients();
      }
    };
    const handleOffline = () => {
      if (clients.length > 0 || brands.length > 0) setOfflineCatalogNotice(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [
    brands.length,
    clientSearch,
    clients.length,
    refreshCatalog,
    searchClients,
    showClientDropdown,
    showMobileClientModal,
  ]);

  // Al volver a foco se revalidan clientes/marcas y, si el selector está
  // abierto, la búsqueda vigente (la caché ya se invalidó antes del aviso).
  useCatalogFocusRevalidation(
    useCallback(() => {
      void refreshCatalog({ force: true });
      if ((showClientDropdown || showMobileClientModal) && clientSearch.trim()) {
        void searchClients();
      }
    }, [refreshCatalog, searchClients, showClientDropdown, showMobileClientModal, clientSearch]),
  );

  const selectedClientId = selectedClient?._id;

  /**
   * Vuelca un pedido en el formulario: cliente, líneas, datos comerciales y
   * descuentos vigentes. Las líneas con productos inactivos se omiten y se
   * avisan; el catálogo de productos se revalida para no usar precios viejos.
   */
  const applyOrderPrefill = useCallback(
    (order: OrderDTO) => {
      const prefill = buildOrderPrefill(order, defaultClientsRef.current);

      if (!prefill.client) {
        showToast(
          'No se pudo cargar el cliente del pedido. Revisá que siga existiendo.',
          'error',
          8000,
        );
        return false;
      }

      const discounts = getClientDiscounts(prefill.client);
      setSelectedClient(prefill.client);
      setClientSearch('');
      setShowClientDropdown(false);
      setQuantities(prefill.quantities);
      // El carrito se valúa con los descuentos vigentes del cliente; los
      // precios salen del catálogo que recupera `useOrderCatalog`.
      setItemDiscounts({});
      setGeneralDiscount(discounts.general);
      setBrandDiscounts(discounts.brandDiscounts);
      setShowBrandDiscountsPanel(Object.keys(discounts.brandDiscounts).length > 0);
      invoiceTypeTouchedRef.current = false;
      paymentConditionTouchedRef.current = false;
      setInvoiceType(prefill.invoiceType);
      setPaymentCondition(prefill.paymentCondition);
      setPaymentConditionDetail(prefill.paymentConditionDetail);
      setComment('');

      invalidateCatalogCache('products');

      const distinct = countSelectedItems(prefill.quantities).distinct;
      if (distinct > 0) setCatalogBrandFilter(SELECTED_PRODUCTS_FILTER);

      const omittedMessage = buildPrefillOmittedMessage(prefill.omittedItems);
      if (omittedMessage) {
        showToast(omittedMessage, 'error', 9000);
      } else if (distinct > 0) {
        showToast(
          isEditMode
            ? 'Borrador cargado en el carrito. Revisá los cambios antes de guardar.'
            : 'Pedido cargado en el carrito. Revisá las cantidades antes de guardar.',
          'success',
        );
      }

      return true;
    },
    [setCatalogBrandFilter, isEditMode, showToast],
  );

  const applyClientPrefill = useCallback((client: OrderCatalogClient) => {
    const discounts = getClientDiscounts(client);
    setSelectedClient(client);
    setGeneralDiscount(discounts.general);
    setBrandDiscounts(discounts.brandDiscounts);
    setShowBrandDiscountsPanel(Object.keys(discounts.brandDiscounts).length > 0);
  }, []);

  /**
   * Cierra la precarga inicial: habilita el autoguardado y, con red, saca de
   * la URL los parámetros transitorios. Así una recarga posterior restaura el
   * borrador actualizado en vez de volver a aplicar el pedido o cliente
   * original. Sin red no se navega: el RSC no está disponible y el HTML
   * cacheado conserva la URL con la que el vendedor ya está trabajando.
   */
  const finishInitialPrefill = useCallback(
    ({ clearUrl = true }: { clearUrl?: boolean } = {}) => {
      setDraftSaveReady(true);

      if (!clearUrl || isEditMode || cleanedPrefillUrlRef.current) return;
      if (isBrowserOffline()) return;

      cleanedPrefillUrlRef.current = true;
      router.replace('/orders/new', { scroll: false });
    },
    [isEditMode, router],
  );

  // Precarga desde el servidor (`?fromOrder=`, `?clientId=`) o, si el pedido
  // no viajó en el primer HTML, con un GET del detalle usando la sesión actual.
  useEffect(() => {
    if (isEditMode && initialOrder) {
      const key = `edit:${initialOrder._id}`;
      if (appliedPrefillRef.current === key) return;
      appliedPrefillRef.current = key;
      applyOrderPrefill(initialOrder);
      return;
    }

    if (initialOrder) {
      const key = `order:${initialOrder._id}`;
      if (appliedPrefillRef.current === key) return;
      appliedPrefillRef.current = key;
      const applied = applyOrderPrefill(initialOrder);
      finishInitialPrefill({ clearUrl: applied });
      return;
    }

    if (fromOrderId) {
      const key = `from:${fromOrderId}`;
      if (appliedPrefillRef.current === key) return;
      let cancelled = false;

      api
        .get<OrderDetailResponse>(`/api/orders/${fromOrderId}`, { cache: 'no-store' })
        .then((data) => {
          if (cancelled || appliedPrefillRef.current === key) return;
          appliedPrefillRef.current = key;
          const applied = applyOrderPrefill(data.order);
          finishInitialPrefill({ clearUrl: applied });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const error = err as Error;
          showToast(error.message || 'No se pudo cargar el pedido para repetirlo', 'error', 8000);
          // Aunque la precarga falle, el alta debe seguir autoguardando: si no,
          // cualquier cambio del vendedor se perdería al recargar.
          setDraftSaveReady(true);
        });

      return () => {
        cancelled = true;
      };
    }

    if (prefilledClient) {
      const key = `client:${prefilledClient._id}`;
      if (appliedPrefillRef.current === key) return;
      appliedPrefillRef.current = key;
      pendingDraftClientRef.current = prefilledClient;
      applyClientPrefill(prefilledClient);
      finishInitialPrefill();
      return;
    }

    if (requestedClientId) {
      const key = `client:${requestedClientId}`;
      if (appliedPrefillRef.current === key) return;
      let cancelled = false;

      const resolveClient = async () => {
        // 1) El cliente ya vino en la lista server-side (primeros 50).
        const fromInitial = initialClients.find((client) => client._id === requestedClientId);
        if (fromInitial) {
          if (cancelled) return;
          appliedPrefillRef.current = key;
          pendingDraftClientRef.current = fromInitial;
          applyClientPrefill(fromInitial);
          finishInitialPrefill();
          return;
        }

        // 2) Con red, ficha puntual por id (puede no estar en los primeros 50).
        if (!isBrowserOffline()) {
          try {
            const data = await api.get<ClientDetailResponse>(`/api/clients/${requestedClientId}`, {
              cache: 'no-store',
            });
            if (cancelled) return;
            appliedPrefillRef.current = key;
            rememberOfflineCatalogClients(userId, [data.client]);
            pendingDraftClientRef.current = data.client;
            applyClientPrefill(data.client);
            finishInitialPrefill();
            return;
          } catch (error) {
            if (isAbortError(error) || cancelled) return;
            // Se intenta la copia local antes de avisar que no existe.
          }
        }

        // 3) Sin red (o si la API falló), el snapshot de IndexedDB.
        try {
          const snapshot = await readOfflineCatalogClients(userId);
          if (cancelled) return;
          const cached = snapshot.items.find((client) => client._id === requestedClientId);
          if (cached) {
            appliedPrefillRef.current = key;
            pendingDraftClientRef.current = cached;
            applyClientPrefill(cached);
            finishInitialPrefill();
            return;
          }
        } catch {
          // Sin IndexedDB se muestra el aviso de cliente inexistente.
        }

        if (cancelled) return;
        appliedPrefillRef.current = key;
        showToast('No se encontró el cliente solicitado para el nuevo pedido', 'error');
        // Se restaura el borrador del usuario igualmente y se habilita el
        // guardado; no tiene sentido dejar el alta sin persistencia por un id
        // de cliente inválido.
        finishInitialPrefill();
      };

      void resolveClient();

      return () => {
        cancelled = true;
      };
    }
  }, [
    applyClientPrefill,
    applyOrderPrefill,
    finishInitialPrefill,
    fromOrderId,
    initialClients,
    initialOrder,
    isEditMode,
    prefilledClient,
    requestedClientId,
    showToast,
    userId,
  ]);

  // "Repetir último pedido": el listado ya viene acotado por la sesión (el
  // vendedor sólo ve los propios) y ordenado por createdAt descendente.
  useEffect(() => {
    let cancelled = false;

    if (!selectedClientId) {
      setLastOrder(null);
      setLastOrderClientId(null);
      setLoadingLastOrder(false);
      return;
    }

    setLastOrder(null);
    setLastOrderClientId(null);
    setLoadingLastOrder(true);

    const params = new URLSearchParams({
      clientId: selectedClientId,
      limit: '1',
      pagination: 'cursor',
      archived: 'all',
    });

    api
      .get<OrderCursorListResponse>(`/api/orders?${params.toString()}`, { cache: 'no-store' })
      .then((data) => {
        if (!cancelled) {
          setLastOrder(data.orders[0] ?? null);
          // La precarga comercial sólo aplica al cliente que originó la
          // consulta, nunca a un pedido anterior de otro cliente.
          setLastOrderClientId(selectedClientId);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error('Error buscando el último pedido del cliente:', err);
          setLastOrder(null);
          setLastOrderClientId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingLastOrder(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedClientId]);

  // Autocompleta factura y condición de pago con el último pedido del cliente.
  // Se respeta cualquier elección manual del vendedor en el pedido actual.
  useEffect(() => {
    if (!selectedClientId || !lastOrder || lastOrderClientId !== selectedClientId) return;

    const next = resolveCommercialDefaultsFromLastOrder({
      current: { invoiceType, paymentCondition, paymentConditionDetail },
      lastOrder,
      invoiceTypeTouched: invoiceTypeTouchedRef.current,
      paymentConditionTouched: paymentConditionTouchedRef.current,
    });
    if (!next) return;

    if (next.invoiceType !== invoiceType) setInvoiceType(next.invoiceType);
    if (next.paymentCondition !== paymentCondition) {
      setPaymentCondition(next.paymentCondition);
    }
    if (next.paymentConditionDetail !== paymentConditionDetail) {
      setPaymentConditionDetail(next.paymentConditionDetail);
    }
  }, [
    invoiceType,
    lastOrder,
    lastOrderClientId,
    paymentCondition,
    paymentConditionDetail,
    selectedClientId,
  ]);

  const handleClientSearchChange = (value: string) => {
    setClientSearch(value);
    setShowClientDropdown(true);
  };

  const handleSelectClient = (client: OrderCatalogClient) => {
    setSelectedClient(client);
    setClientSearch('');
    setShowClientDropdown(false);

    const discounts = getClientDiscounts(client);
    setGeneralDiscount(discounts.general);
    setBrandDiscounts(discounts.brandDiscounts);
    // Si el cliente trae descuentos por marca, mostrarlos de entrada.
    if (Object.keys(discounts.brandDiscounts).length > 0) setShowBrandDiscountsPanel(true);

    // Recientes/frecuentes por usuario: la UI se actualiza al instante y la
    // frecuencia se persiste sin bloquear la selección.
    setRecentClients((prev) =>
      [client, ...prev.filter((item) => item._id !== client._id)].slice(0, 5),
    );
    void recordOfflineRecentClient(userId, client).catch((error) => {
      console.warn('No se pudo guardar el cliente reciente:', error);
    });
  };

  // Quitar el cliente también limpia sus descuentos: evita totales con descuentos "fantasma".
  const handleClearClient = () => {
    setSelectedClient(null);
    setGeneralDiscount(0);
    setBrandDiscounts({});
    setShowBrandDiscountsPanel(false);
  };

  /** Abre el alta rápida sin abandonar el pedido ni apilar ambos modales. */
  const handleOpenQuickCreateClient = () => {
    if (isEditMode) return;
    setShowClientDropdown(false);
    setShowMobileClientModal(false);
    setShowQuickCreateClientModal(true);
  };

  /**
   * Alta rápida exitosa: la ficha entra al catálogo local y al snapshot offline,
   * y queda seleccionada en el pedido actual.
   */
  const handleClientCreated = (client: ClientDTO) => {
    invalidateCatalogCache('clients');
    rememberOfflineCatalogClients(userId, [client]);

    setClients((previous) => {
      const next = [client, ...previous.filter((item) => item._id !== client._id)].slice(0, 50);
      defaultClientsRef.current = next;
      return next;
    });

    setShowQuickCreateClientModal(false);
    // Además de seleccionarlo, guarda el cliente en recientes/frecuentes.
    handleSelectClient(client);
    showToast('Cliente creado y seleccionado exitosamente', 'success');
  };

  const handleRepeatLastOrder = () => {
    if (!lastOrder) return;

    setRepeatConfirm({
      orderId: lastOrder._id,
      clientName: selectedClient?.name ?? 'el cliente',
    });
  };

  const handleConfirmRepeatLastOrder = async () => {
    if (!repeatConfirm) return;

    const { orderId, clientName } = repeatConfirm;
    setRepeatConfirm(null);

    try {
      const data = await api.get<OrderDetailResponse>(`/api/orders/${orderId}`, {
        cache: 'no-store',
      });
      applyOrderPrefill(data.order);
    } catch (err: unknown) {
      const repeatError = err as Error;
      showToast(
        repeatError.message || `No se pudo cargar el último pedido de ${clientName}`,
        'error',
        8000,
      );
    }
  };

  const handleInvoiceTypeChange = (value: InvoiceType | '') => {
    invoiceTypeTouchedRef.current = true;
    setInvoiceType(value);
  };

  const handlePaymentConditionChange = (value: PaymentCondition | '') => {
    paymentConditionTouchedRef.current = true;
    setPaymentCondition(value);
    // El detalle solo existe para "Otro": al cambiar de opción se limpia.
    if (value !== 'otro') setPaymentConditionDetail('');
  };

  const handleQuantityChange = useCallback((productId: string, value: string) => {
    const quantity = parseQuantityInput(value);
    setQuantities((prev) => ({ ...prev, [productId]: quantity }));
  }, []);

  // Actualización relativa para los botones +/- del móvil:
  // evita perder toques rápidos consecutivos al no depender del render previo.
  const handleQuantityDelta = useCallback((productId: string, delta: number) => {
    setQuantities((prev) => ({
      ...prev,
      [productId]: applyQuantityDelta(prev[productId], delta),
    }));
  }, []);

  const handleRemoveItem = useCallback((productId: string) => {
    setQuantities((prev) => {
      if (!prev[productId]) return prev;
      return { ...prev, [productId]: 0 };
    });
    setItemDiscounts((prev) => {
      if (prev[productId] === undefined) return prev;
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }, []);

  const handleClearCart = useCallback(() => {
    setQuantities({});
    setItemDiscounts({});
  }, []);

  // Vaciar el campo de un producto = volver al descuento de marca/general (evita forzar 0%).
  const handleDiscountChange = useCallback((productId: string, value: string) => {
    const discount = parseDiscountInput(value);
    setItemDiscounts((prev) => {
      const next = { ...prev };
      if (discount === undefined) delete next[productId];
      else next[productId] = discount;
      return next;
    });
  }, []);

  const handleDiscountClear = useCallback((productId: string) => {
    setItemDiscounts((prev) => {
      if (prev[productId] === undefined) return prev;
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }, []);

  // Campo vacío = la marca hereda el descuento general (no lo pisa con 0).
  const handleBrandDiscountChange = useCallback((brandId: string, value: string) => {
    const discount = parseDiscountInput(value);
    setBrandDiscounts((prev) => {
      const next = { ...prev };
      if (discount === undefined) delete next[brandId];
      else next[brandId] = discount;
      return next;
    });
  }, []);

  const handleBrandDiscountClear = useCallback((brandId: string) => {
    setBrandDiscounts((prev) => {
      if (prev[brandId] === undefined) return prev;
      const next = { ...prev };
      delete next[brandId];
      return next;
    });
  }, []);

  const handleClearAllBrandDiscounts = useCallback(() => {
    setBrandDiscounts({});
  }, []);

  const handleGeneralDiscountChange = (value: string) => {
    setGeneralDiscount(parseGeneralDiscount(value));
  };

  // Valores configurados en la ficha del cliente: permiten distinguir en la UI
  // un descuento "de cliente" de uno ajustado manualmente en este pedido.
  const clientBaseline = useMemo(() => {
    const discounts = getClientDiscounts(selectedClient);
    return { general: discounts.general, brands: discounts.brandDiscounts };
  }, [selectedClient]);

  // Totales del pedido en una sola pasada O(n) sobre los ítems del carrito.
  // Además separa el descuento por origen (general / marca / manual) para el resumen.
  const { subtotal, totalDiscount, finalTotal, discountBySource } = useMemo(
    () =>
      calculateOrderTotals({
        quantities,
        productCache,
        itemDiscounts,
        brandDiscounts,
        generalDiscount,
      }),
    [quantities, productCache, itemDiscounts, brandDiscounts, generalDiscount],
  );

  const handleSubmitOrder = async () => {
    if (submittingRef.current) return;

    if (!salesperson.trim()) {
      showToast('No se pudo identificar el vendedor de la sesión', 'error');
      return;
    }

    if (!selectedClient) {
      showToast('Debe seleccionar un cliente antes de guardar', 'error');
      return;
    }

    if (!invoiceType) {
      showToast('Seleccioná el tipo de factura antes de guardar', 'error');
      return;
    }

    if (!paymentCondition) {
      showToast('Seleccioná una condición de pago antes de guardar', 'error');
      return;
    }

    if (paymentCondition === 'otro' && !paymentConditionDetail.trim()) {
      showToast('Ingresá el detalle de la condición de pago cuando elegís "Otro"', 'error');
      return;
    }

    const { items, missingProductIds } = buildOrderItems({
      quantities,
      productCache,
      itemDiscounts,
      brandDiscounts,
      generalDiscount,
    });

    if (missingProductIds.length > 0) {
      showToast(
        'Esperando datos de los productos seleccionados. Intente nuevamente en un instante.',
        'error',
      );
      return;
    }

    if (items.length === 0) {
      showToast('Debe ingresar al menos una cantidad mayor a 0 en los productos', 'error');
      return;
    }

    // Edición de un borrador propio: reemplaza ítems y datos comerciales en el
    // mismo pedido, con la versión leída para detectar cambios de depósito.
    if (isEditMode) {
      if (!initialOrder) {
        showToast('No se pudo identificar el borrador que estás editando', 'error');
        return;
      }

      submittingRef.current = true;
      setLoading(true);

      try {
        await api.put<OrderMutationResponse>(`/api/orders/${initialOrder._id}`, {
          mode: 'draft-edit',
          version: initialOrder.version ?? 0,
          items,
          invoiceType,
          paymentCondition,
          paymentConditionDetail:
            paymentCondition === 'otro' ? paymentConditionDetail.trim() : undefined,
          comment: comment.trim() || undefined,
        });

        showToast('Borrador actualizado exitosamente', 'success');
        markOrdersTrayForRefresh('/orders');
        markOrdersTrayForRefresh(`/orders/${initialOrder._id}`);
        startTransition(() => router.push(`/orders/${initialOrder._id}`));
      } catch (err: unknown) {
        const error = err as Error;
        showToast(error.message || 'No se pudo actualizar el borrador', 'error', 8000);
      } finally {
        submittingRef.current = false;
        setLoading(false);
      }

      return;
    }

    submittingRef.current = true;
    setLoading(true);

    const clientRequestId = createClientRequestId();
    const orderBody = {
      clientId: selectedClient._id,
      items,
      comment: comment.trim(),
      invoiceType,
      paymentCondition,
      paymentConditionDetail:
        paymentCondition === 'otro' ? paymentConditionDetail.trim() : undefined,
      clientRequestId,
    };

    const resetFormAfterQueue = () => {
      clearDraft();
      setQuantities({});
      setItemDiscounts({});
      setGeneralDiscount(0);
      setBrandDiscounts({});
      setComment('');
      invoiceTypeTouchedRef.current = false;
      paymentConditionTouchedRef.current = false;
      setInvoiceType('');
      setPaymentCondition('');
      setPaymentConditionDetail('');
      setSelectedClient(null);
      setClientSearch('');
      setShowBrandDiscountsPanel(false);
      setShowMobileCheckoutModal(false);
    };

    const saveLocally = async (message: string) => {
      try {
        await enqueuePendingOrderCreate({
          url: '/api/orders',
          body: orderBody,
          clientRequestId,
          clientName: selectedClient.name,
          total: finalTotal,
        });
        resetFormAfterQueue();
        setPendingSyncRequestId(clientRequestId);
        void requestOrderBackgroundSync();
        showToast(message, 'success', 7000);
      } catch (queueError) {
        console.error('Error guardando el pedido en IndexedDB:', queueError);
        showToast(
          'No se pudo guardar el pedido localmente. Revisá el almacenamiento del navegador e intentá de nuevo.',
          'error',
          7000,
        );
      }
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await saveLocally(
          'Pendiente de sincronizar: el pedido quedó guardado en este dispositivo y se enviará al reconectar.',
        );
        return;
      }

      const created = await api.post<OrderMutationResponse>('/api/orders', orderBody);
      const createdOrderId = created.order?._id;

      // El toast vive en el layout raíz y sobrevive a la navegación: no hace
      // falta retrasar el redirect para que el usuario lo vea.
      showToast('¡Pedido creado en estado Borrador exitosamente!', 'success');
      clearDraft();
      setQuantities({});
      setItemDiscounts({});
      invoiceTypeTouchedRef.current = false;
      paymentConditionTouchedRef.current = false;
      setInvoiceType('');
      setPaymentCondition('');
      setPaymentConditionDetail('');
      // El alta encadena directo al detalle: el vendedor puede compartir el
      // resumen o iniciar el próximo pedido sin volver al panel.
      markOrdersTrayForRefresh('/orders');
      startTransition(() => {
        router.push(createdOrderId ? `/orders/${createdOrderId}` : '/orders');
      });
    } catch (err: unknown) {
      // Sin conexión o servidor no disponible: el body completo (incluida la
      // clave idempotente) queda en IndexedDB para reintentarse sin duplicar.
      if (
        isNetworkError(err) ||
        (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        (err instanceof ApiClientError && isRetriableOrderPutStatus(err.status))
      ) {
        await saveLocally(
          'Pendiente de sincronizar: el pedido quedó guardado y se enviará al reconectar.',
        );
        return;
      }

      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  const clientDetails: ClientDetailsStateProps = {
    loadingLastOrder,
    lastOrder,
    onRepeat: handleRepeatLastOrder,
    allowRepeat: !isEditMode,
    generalDiscount,
    baselineGeneralDiscount: clientBaseline.general,
    onGeneralDiscountChange: handleGeneralDiscountChange,
    onRestoreGeneralDiscount: () => setGeneralDiscount(clientBaseline.general),
    brands,
    brandDiscounts,
    baselineBrands: clientBaseline.brands,
    showBrandDiscountsPanel,
    onToggleBrandDiscounts: () => setShowBrandDiscountsPanel((current) => !current),
    onBrandDiscountChange: handleBrandDiscountChange,
    onBrandDiscountClear: handleBrandDiscountClear,
    onClearAllBrandDiscounts: handleClearAllBrandDiscounts,
  };

  return (
    <AppShell
      role={role}
      username={salesperson}
      pageTitle={isEditMode ? 'Editar pedido' : 'Nuevo pedido'}
      pageDescription={
        isEditMode
          ? 'Ajustá el borrador antes de guardarlo.'
          : 'Cliente, catálogo, descuentos y resumen del pedido.'
      }
      backLabel="Volver"
      backHref={backHref}
      maxWidth="7xl"
      mainClassName="max-lg:[&_input]:scroll-mb-24 max-lg:[&_textarea]:scroll-mb-24"
    >
      {pendingSyncRequestId && <OfflinePendingBanner clientRequestId={pendingSyncRequestId} />}

      {(offlineCatalogNotice || catalog.catalogFromCache) && (
        <div className="mb-4">
          <OfflineCatalogBadge
            detail={
              catalog.catalogFromCache
                ? 'catálogo de productos'
                : 'clientes y marcas guardados en este dispositivo'
            }
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4 lg:gap-8">
        <MobileClientPanel
          selectedClient={selectedClient}
          onOpenClientModal={() => setShowMobileClientModal(true)}
          lockClient={isEditMode}
          details={clientDetails}
          invoiceType={invoiceType}
          onInvoiceTypeChange={handleInvoiceTypeChange}
          paymentCondition={paymentCondition}
          onPaymentConditionChange={handlePaymentConditionChange}
          paymentConditionDetail={paymentConditionDetail}
          onPaymentConditionDetailChange={setPaymentConditionDetail}
        />

        {/* Columna Izquierda (Escritorio): Cliente, Descuentos y Resumen */}
        <div className="hidden lg:block lg:col-span-1 space-y-6">
          <Card className="sticky top-20">
            <ClientPanel
              salesperson={salesperson}
              clientSearch={clientSearch}
              onClientSearchChange={handleClientSearchChange}
              onClientSearchFocus={() => setShowClientDropdown(true)}
              showClientDropdown={showClientDropdown}
              clients={clients}
              recentClients={recentClients}
              selectedClient={selectedClient}
              onSelectClient={handleSelectClient}
              onClearClient={handleClearClient}
              onCreateClient={handleOpenQuickCreateClient}
              lockClient={isEditMode}
              details={clientDetails}
              invoiceType={invoiceType}
              onInvoiceTypeChange={handleInvoiceTypeChange}
              paymentCondition={paymentCondition}
              onPaymentConditionChange={handlePaymentConditionChange}
              paymentConditionDetail={paymentConditionDetail}
              onPaymentConditionDetailChange={setPaymentConditionDetail}
              comment={comment}
              onCommentChange={setComment}
            />

            <OrderSummaryPanel
              subtotal={subtotal}
              totalDiscount={totalDiscount}
              finalTotal={finalTotal}
              discountBySource={discountBySource}
              quantities={quantities}
              productCache={productCache}
              itemDiscounts={itemDiscounts}
              brandDiscounts={brandDiscounts}
              generalDiscount={generalDiscount}
              onQuantityChange={handleQuantityChange}
              onQuantityDelta={handleQuantityDelta}
              onRemoveItem={handleRemoveItem}
              loading={loading}
              onSubmit={handleSubmitOrder}
              submitLabel={isEditMode ? 'Guardar Cambios' : undefined}
            />
          </Card>
        </div>

        {/* Columna Derecha: Catálogo en Planilla por Marcas */}
        <div className="lg:col-span-3 space-y-6">
          <OrderCatalog
            brands={brands}
            catalog={catalog}
            quantities={quantities}
            itemDiscounts={itemDiscounts}
            generalDiscount={generalDiscount}
            brandDiscounts={brandDiscounts}
            baselineBrands={clientBaseline.brands}
            onQuantityChange={handleQuantityChange}
            onQuantityDelta={handleQuantityDelta}
            onDiscountChange={handleDiscountChange}
            onDiscountClear={handleDiscountClear}
            onBrandDiscountChange={handleBrandDiscountChange}
            onBrandDiscountClear={handleBrandDiscountClear}
            onClearCart={handleClearCart}
          />
        </div>
      </div>

      <MobileActionBar
        hasClient={Boolean(selectedClient)}
        hasInvoiceType={Boolean(invoiceType)}
        hasPaymentCondition={Boolean(paymentCondition)}
        distinctProductsCount={distinctProductsCount}
        finalTotal={finalTotal}
        inputFocused={inputFocused}
        onOpenSummary={() => setShowMobileCheckoutModal(true)}
      />

      <ConfirmDialog
        open={repeatConfirm !== null}
        title="Repetir último pedido"
        message={
          repeatConfirm
            ? `Se cargarán las líneas del último pedido de ${repeatConfirm.clientName} en el carrito, con precios y descuentos vigentes. ¿Continuar?`
            : ''
        }
        confirmLabel="Cargar en el carrito"
        variant="primary"
        onConfirm={handleConfirmRepeatLastOrder}
        onClose={() => setRepeatConfirm(null)}
      />

      {/* Los modales se montan sólo cuando se abren (y ahí se pide el chunk). */}
      {showMobileClientModal && (
        <MobileClientModal
          open
          onClose={() => setShowMobileClientModal(false)}
          clients={clients}
          recentClients={recentClients}
          selectedClient={selectedClient}
          search={clientSearch}
          onSearchChange={setClientSearch}
          onSelectClient={handleSelectClient}
          onCreateClient={handleOpenQuickCreateClient}
        />
      )}

      {showQuickCreateClientModal && (
        <QuickCreateClientModal
          open
          initialSearch={clientSearch}
          onClose={() => setShowQuickCreateClientModal(false)}
          onClientCreated={handleClientCreated}
        />
      )}

      {showMobileCheckoutModal && (
        <MobileCheckoutModal
          open
          onClose={() => setShowMobileCheckoutModal(false)}
          salesperson={salesperson}
          selectedClient={selectedClient}
          onChangeClient={() => setShowMobileClientModal(true)}
          comment={comment}
          onCommentChange={setComment}
          invoiceType={invoiceType}
          onInvoiceTypeChange={handleInvoiceTypeChange}
          paymentCondition={paymentCondition}
          onPaymentConditionChange={handlePaymentConditionChange}
          paymentConditionDetail={paymentConditionDetail}
          onPaymentConditionDetailChange={setPaymentConditionDetail}
          brands={brands}
          brandDiscounts={brandDiscounts}
          baselineBrands={clientBaseline.brands}
          generalDiscount={generalDiscount}
          baselineGeneralDiscount={clientBaseline.general}
          onGeneralDiscountChange={handleGeneralDiscountChange}
          onRestoreGeneralDiscount={() => setGeneralDiscount(clientBaseline.general)}
          showBrandDiscountsPanel={showBrandDiscountsPanel}
          onToggleBrandDiscounts={() => setShowBrandDiscountsPanel((current) => !current)}
          onBrandDiscountChange={handleBrandDiscountChange}
          onBrandDiscountClear={handleBrandDiscountClear}
          onClearAllBrandDiscounts={handleClearAllBrandDiscounts}
          quantities={quantities}
          productCache={productCache}
          itemDiscounts={itemDiscounts}
          onQuantityChange={handleQuantityChange}
          onQuantityDelta={handleQuantityDelta}
          onRemoveItem={handleRemoveItem}
          subtotal={subtotal}
          totalDiscount={totalDiscount}
          finalTotal={finalTotal}
          discountBySource={discountBySource}
          totalItemsCount={totalItemsCount}
          distinctProductsCount={distinctProductsCount}
          loading={loading}
          onSubmit={handleSubmitOrder}
          submitLabel={isEditMode ? 'Guardar Cambios' : undefined}
          lockClient={isEditMode}
        />
      )}
    </AppShell>
  );
}
