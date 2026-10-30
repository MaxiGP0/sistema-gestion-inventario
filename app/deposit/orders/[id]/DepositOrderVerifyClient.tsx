'use client';

import { useState, useEffect, useCallback, useId, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ClipboardCheck,
  Building2,
  Package,
  Plus,
  Minus,
  Trash2,
  Search,
  CloudUpload,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import AppShell from '@/components/app-shell/AppShell';
import ConfirmDialog from '@/components/ConfirmDialog';
import CommentsPanel from '@/components/CommentsPanel';
import StatusBadge from '@/components/StatusBadge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import QuantityStepper from '@/components/ui/QuantityStepper';
import ProductThumbnail from '@/components/ProductThumbnail';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
} from '@/components/ui/Table';
import OrderDetailSkeleton from '@/components/orders/OrderDetailSkeleton';
import OrderLineFilters from '@/components/orders/OrderLineFilters';
import OrderPrintLink from '@/components/orders/OrderPrintLink';
import OrderShareButtons from '@/components/orders/OrderShareButtons';
import OrderStaleVersionBanner from '@/components/orders/OrderStaleVersionBanner';
import OfflineCatalogBadge from '@/components/orders/new/OfflineCatalogBadge';
import { useOrderDetail } from '@/hooks/useOrderDetail';
import { useMobileKeyboardFocus } from '@/hooks/useVisualViewport';
import { orderVersion } from '@/lib/order-live-sync';
import {
  countOrderLineFilters,
  filterOrderLines,
  type OrderLineFilter,
} from '@/lib/order-line-filter';
import { PENDING_REASON_REMOVED, PENDING_REASON_UNCONTROLLED } from '@/lib/order-totals';
import {
  applyPickingQuantityDelta,
  buildPickingState,
  countPendingPickingLines,
  countQuickControlCandidates,
  isPickingLinePending,
  markPickingLineOutOfStock,
  markPickingLineRequested,
  markRemainingLinesRequested,
  pickingItemKey,
  restorePickingSnapshot,
  setPickingLineQuantity,
  shouldShowPickingShortcuts,
  type PickingState,
} from '@/lib/picking-control';
import {
  clearPickingAutosave,
  loadPickingAutosave,
  savePickingAutosave,
  type PickingAutosaveSnapshot,
} from '@/lib/picking-autosave';
import { getOrdersTrayBackHref } from '@/lib/orders-tray';
import { markOrdersTrayForRefresh } from '@/lib/orders-tray-refresh';
import {
  buildDepositAddedItem,
  depositLineTotal,
  findDepositItemByProductId,
  isDepositAddedLine,
  normalizeDepositAddQuantity,
  planDepositExistingAddition,
} from '@/lib/deposit-add-product';
import { searchOfflineCatalogProducts } from '@/lib/offline-catalog';
import { isBrowserOffline, rememberOfflineCatalogProducts } from '@/lib/offline-catalog-sync';
import {
  enqueuePendingOrderPut,
  getPendingOrderPuts,
  OFFLINE_QUEUE_CHANGED_EVENT,
} from '@/lib/offline-order-queue';
import { isRetriableOrderPutStatus } from '@/lib/order-put-sync-core';
import { requestOrderPutBackgroundSync } from '@/lib/order-put-sync';
import { apiRequest, ApiClientError, isAbortError, isNetworkError } from '@/lib/api-client';
import { getCatalog } from '@/lib/catalog-query-cache';
import { useCatalogFocusRevalidation } from '@/hooks/useCatalogFocusRevalidation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import type { UserRole } from '@/lib/authz';
import type {
  OrderDTO,
  OrderItemDTO,
  OrderMutationResponse,
  ProductDTO,
  ProductListResponse,
} from '@/lib/types';

/** Las líneas nuevas (agregadas en depósito) todavía no tienen `_id`. */
type OrderItem = Omit<OrderItemDTO, '_id'> & { _id?: string };

type Order = Omit<OrderDTO, 'items'> & { items: OrderItem[] };

type ProductCatalog = ProductDTO;

/** localStorage puede no estar disponible (SSR o modo privado). */
function resolveLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface DepositOrderVerifyClientProps {
  orderId: string;
  /** Dueño del snapshot offline (sesión resuelta en el servidor). */
  userId: string;
  role: UserRole;
  username: string;
  /** Pedido resuelto en el servidor; evita el spinner y el GET de montaje. */
  initialOrder: OrderDTO | null;
  initialError: string | null;
  initialFetchedAt?: number;
}

export default function DepositOrderVerifyClient({
  orderId: id,
  userId,
  role,
  username,
  initialOrder,
  initialError,
  initialFetchedAt,
}: DepositOrderVerifyClientProps) {
  const backHref = getOrdersTrayBackHref('/deposit/orders');
  const { showToast } = useToast();
  const [itemsState, setItemsState] = useState<PickingState>(() =>
    buildPickingState((initialOrder as Order | null)?.items ?? []),
  );
  const initializedItemsForOrderRef = useRef<string | null>(initialOrder?._id ?? null);
  // Un cambio manual en el picking no debe ser pisado por una revalidación
  // silenciosa: si el servidor avanzó de versión se ofrece cargarla.
  const hasLocalPickingChangesRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingComment, setSavingComment] = useState(false);
  const [queuedLocally, setQueuedLocally] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [quickUndo, setQuickUndo] = useState<{ state: PickingState; changed: number } | null>(null);
  const [confirmQuickControlOpen, setConfirmQuickControlOpen] = useState(false);
  const [restorableSnapshot, setRestorableSnapshot] = useState<PickingAutosaveSnapshot | null>(
    null,
  );
  const [autosaveReady, setAutosaveReady] = useState(false);
  const autosaveCheckedForRef = useRef<string | null>(null);
  const [lineFilter, setLineFilter] = useState<OrderLineFilter>('all');
  const [lineSearch, setLineSearch] = useState('');
  const [pinnedItemKey, setPinnedItemKey] = useState<string | null>(null);
  const [isNavigating, startTransition] = useTransition();
  const inputFocused = useMobileKeyboardFocus();

  // Estados para agregar productos adicionales
  const [catalogProducts, setCatalogProducts] = useState<ProductCatalog[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogFromCache, setCatalogFromCache] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [itemToRemove, setItemToRemove] = useState<{
    itemId: string;
    productId?: string;
    name: string;
  } | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [addQuantity, setAddQuantity] = useState(1);
  const catalogRequest = useLatestRequest();
  const addProductSearchRef = useRef<HTMLInputElement>(null);
  const mobileReasonRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const addProductTitleId = useId();

  const { order, setOrder, loading, error, pendingOrder, applyPendingOrder } =
    useOrderDetail<Order>(id, {
      initialOrder: initialOrder as Order | null,
      initialError,
      initialFetchedAt,
      hasLocalChanges: () => hasLocalPickingChangesRef.current,
      onRemoteOrderApplied: (remote, previous) => {
        // Sólo se avisa cuando la lectura realmente trae una versión más nueva.
        if (!previous || orderVersion(remote) <= orderVersion(previous)) return;

        hasLocalPickingChangesRef.current = false;
        initializedItemsForOrderRef.current = remote._id;
        setItemsState(buildPickingState(remote.items));
        setQuickUndo(null);
        setRestorableSnapshot(null);
        setAutosaveReady(true);
        showToast('Pedido actualizado', 'success');
      },
      onRemoteMetadataMerged: (merged, previous) => {
        // Un comentario de otra persona avanzó la versión: el autosave en curso
        // debe quedar asociado a esa versión para poder restaurarse después.
        if (!previous || orderVersion(merged) <= orderVersion(previous)) return;
        if (!hasLocalPickingChangesRef.current) return;

        savePickingAutosave(resolveLocalStorage(), {
          orderId: merged._id,
          userId,
          version: orderVersion(merged),
          savedAt: Date.now(),
          items: itemsState,
        });
      },
    });

  const router = useRouter();

  // Si el pedido llegó por fetch (sin data inicial), se hidrata el picking una
  // sola vez. Las revalidaciones posteriores no pisan lo que el operario editó.
  useEffect(() => {
    if (!order || initializedItemsForOrderRef.current === order._id) return;

    initializedItemsForOrderRef.current = order._id;
    setItemsState(buildPickingState(order.items));
  }, [order]);

  // Autosave local: se ofrece el snapshot una sola vez por pedido y sólo si
  // corresponde a la versión actual (menos de 24 h). Mientras el banner está
  // visible no se escribe nada para no pisarlo.
  useEffect(() => {
    if (!order || autosaveCheckedForRef.current === order._id) return;
    autosaveCheckedForRef.current = order._id;

    const snapshot = loadPickingAutosave(resolveLocalStorage(), {
      orderId: order._id,
      userId,
      version: order.version ?? 0,
    });

    if (snapshot) {
      setRestorableSnapshot(snapshot);
      setAutosaveReady(false);
    } else {
      setAutosaveReady(true);
    }
  }, [order, userId]);

  useEffect(() => {
    // No guardar un control intacto: al reabrir el pedido no debe ofrecerse
    // restaurar un snapshot idéntico al que ya está en el servidor.
    if (!order || !autosaveReady || !hasLocalPickingChangesRef.current) return;

    const timer = setTimeout(() => {
      savePickingAutosave(resolveLocalStorage(), {
        orderId: order._id,
        userId,
        version: order.version ?? 0,
        savedAt: Date.now(),
        items: itemsState,
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [autosaveReady, itemsState, order, userId]);

  const loadCatalog = useCallback(async () => {
    // Cancela la búsqueda anterior y usa el id como segunda barrera.
    const ticket = catalogRequest.start();
    setLoadingCatalog(true);

    const loadLocal = async (): Promise<boolean> => {
      try {
        const snapshot = await searchOfflineCatalogProducts(userId, productSearch.trim(), {
          limit: 30,
        });
        if (!catalogRequest.isCurrent(ticket)) return false;

        if (snapshot.total > 0 || snapshot.expired > 0 || isBrowserOffline()) {
          setCatalogProducts(snapshot.items as ProductCatalog[]);
          setCatalogFromCache(true);
        }
        return snapshot.total > 0;
      } catch (error) {
        console.error('Error buscando productos guardados:', error);
        return false;
      }
    };

    // 1) Hidratar desde IndexedDB: si hay red, estos resultados se ven al
    // instante y la respuesta del servidor los reemplaza después.
    const hadCachedResults = await loadLocal();
    if (!catalogRequest.isCurrent(ticket)) return;

    if (isBrowserOffline() || hadCachedResults) setLoadingCatalog(false);
    if (isBrowserOffline()) return;

    try {
      const params = new URLSearchParams({ limit: '30' });
      if (productSearch.trim()) params.set('search', productSearch.trim());

      const data = await getCatalog<ProductListResponse>(`/api/products?${params.toString()}`, {
        signal: ticket.signal,
        // La copia local ya se mostró: revalidar siempre contra el servidor.
        force: true,
      });

      // Descartar respuestas obsoletas (peticiones reemplazadas o canceladas).
      if (!catalogRequest.isCurrent(ticket)) return;

      setCatalogProducts(data.products);
      setCatalogFromCache(false);
      rememberOfflineCatalogProducts(userId, data.products);
    } catch (err) {
      if (isAbortError(err) || !catalogRequest.isCurrent(ticket)) return;
      console.error('Error cargando catálogo:', err);
      // Red caída con navigator.onLine todavía en true: se queda la copia
      // local con el aviso visible.
      if (!hadCachedResults) await loadLocal();
    } finally {
      if (catalogRequest.isCurrent(ticket)) setLoadingCatalog(false);
    }
  }, [catalogRequest, productSearch, userId]);

  // Búsqueda del catálogo en el servidor (paginada) solo cuando el modal está abierto.
  useEffect(() => {
    if (!showAddModal) {
      catalogRequest.abort();
      return;
    }

    const timer = setTimeout(
      () => {
        void loadCatalog();
      },
      productSearch.trim() ? 300 : 0,
    );

    return () => {
      clearTimeout(timer);
      // Cambió la búsqueda, se cerró el modal o se desmontó: cancelar ya.
      catalogRequest.abort();
    };
  }, [showAddModal, productSearch, loadCatalog, catalogRequest]);

  // Al volver a foco se revalida el catálogo si el modal sigue abierto.
  useCatalogFocusRevalidation(
    useCallback(() => {
      if (showAddModal) void loadCatalog();
    }, [showAddModal, loadCatalog]),
  );

  // Refleja si este pedido tiene un picking esperando sincronización. Se
  // actualiza cuando la cola cambia (nuevo guardado, reintento o descarte).
  useEffect(() => {
    let active = true;

    const refreshQueuedState = async () => {
      try {
        const entries = await getPendingOrderPuts();
        if (active) {
          // Las entradas fallidas se muestran en el indicador global de error,
          // no como un picking todavía pendiente de sincronizar.
          setQueuedLocally(
            entries.some((entry) => entry.orderId === id && entry.status !== 'failed'),
          );
        }
      } catch {
        // IndexedDB puede no estar disponible (modo privado): el guardado
        // offline fallará de forma explícita al intentar usarlo.
      }
    };

    void refreshQueuedState();
    window.addEventListener(OFFLINE_QUEUE_CHANGED_EVENT, refreshQueuedState);

    return () => {
      active = false;
      window.removeEventListener(OFFLINE_QUEUE_CHANGED_EVENT, refreshQueuedState);
    };
  }, [id]);

  const pendingPickingCount = countPendingPickingLines(order?.items ?? [], itemsState);
  const quickControlCandidates = countQuickControlCandidates(order?.items ?? [], itemsState);
  const currentVersion = orderVersion(order);
  const pendingVersion = orderVersion(pendingOrder);
  const showStaleVersionBanner = Boolean(pendingOrder) && pendingVersion > currentVersion;

  /**
   * Con un chip activo, la tarjeta que el operario está tocando se conserva
   * visible aunque el cambio la saque del filtro (por ejemplo, controlarla).
   * Al tocar otra línea el pin pasa a esa tarjeta; cambiar chip o búsqueda lo
   * libera para que el filtro vuelva a mandar.
   */
  const pinActiveLine = useCallback(
    (key: string) => {
      setPinnedItemKey(lineFilter === 'all' ? null : key);
    },
    [lineFilter],
  );

  const handleLineFilterChange = useCallback((next: OrderLineFilter) => {
    setPinnedItemKey(null);
    setLineFilter(next);
  }, []);

  const handleLineSearchChange = useCallback((next: string) => {
    setPinnedItemKey(null);
    setLineSearch(next);
  }, []);

  const lineFilterPredicates = {
    isPending: (item: OrderItem) => isPickingLinePending(itemsState[pickingItemKey(item)]),
    hasDifference: (item: OrderItem) => {
      const state = itemsState[pickingItemKey(item)];
      if (!state) return false;
      if (state.pendingReason === PENDING_REASON_REMOVED) return true;
      return state.controlled && state.verifiedQty < item.requestedQuantity;
    },
  };
  const lineFilterCounts = countOrderLineFilters(order?.items ?? [], lineFilterPredicates);
  const showLineFilters = (order?.items.length ?? 0) > 5;
  const pinnedLineKeys = pinnedItemKey ? new Set([pinnedItemKey]) : undefined;
  const visibleItems = showLineFilters
    ? filterOrderLines(
        order?.items ?? [],
        { filter: lineFilter, query: lineSearch, pinnedKeys: pinnedLineKeys },
        lineFilterPredicates,
        pickingItemKey,
      )
    : (order?.items ?? []);

  const clearAutosaveAfterSave = useCallback(() => {
    // Detiene el debounce antes de borrar para que el timer pendiente no
    // vuelva a escribir el snapshot durante la redirección.
    setAutosaveReady(false);
    clearPickingAutosave(resolveLocalStorage(), userId, id);
  }, [id, userId]);

  /** Un cambio manual invalida el "Deshacer" masivo y descarta un snapshot viejo. */
  const markManualPickingEdit = useCallback(() => {
    hasLocalPickingChangesRef.current = true;
    setQuickUndo(null);
    if (restorableSnapshot) {
      clearPickingAutosave(resolveLocalStorage(), userId, id);
      setRestorableSnapshot(null);
      setAutosaveReady(true);
    }
  }, [id, restorableSnapshot, userId]);

  /** El operario acepta descartar su pintura y seguir con la versión del servidor. */
  const handleLoadLatestVersion = useCallback(() => {
    hasLocalPickingChangesRef.current = false;
    applyPendingOrder();
  }, [applyPendingOrder]);

  const handleQuickControl = () => {
    if (!order || quickControlCandidates === 0) return;

    markManualPickingEdit();
    const result = markRemainingLinesRequested(order.items, itemsState);
    setItemsState(result.state);
    setQuickUndo({ state: result.snapshot, changed: result.changed });
    showToast(
      result.changed === 1
        ? 'Se marcó 1 línea con la cantidad pedida.'
        : `Se marcaron ${result.changed} líneas con la cantidad pedida.`,
      'success',
    );
  };

  const handleUndoQuickControl = () => {
    if (!quickUndo) return;

    setItemsState(restorePickingSnapshot(quickUndo.state));
    setQuickUndo(null);
    showToast('Se deshizo el control rápido.', 'success');
  };

  const handleRestoreAutosave = () => {
    if (!restorableSnapshot) return;

    hasLocalPickingChangesRef.current = true;
    setItemsState(restorePickingSnapshot(restorableSnapshot.items));
    setQuickUndo(null);
    setRestorableSnapshot(null);
    setAutosaveReady(true);
    showToast('Control restaurado desde este dispositivo.', 'success');
  };

  const handleDiscardAutosave = () => {
    clearPickingAutosave(resolveLocalStorage(), userId, id);
    setRestorableSnapshot(null);
    setAutosaveReady(true);
    showToast('Se descartó el control guardado en este dispositivo.', 'success');
  };

  const handleToggleControlled = (itemId: string) => {
    pinActiveLine(itemId);
    markManualPickingEdit();
    setItemsState((prev) => {
      const current = prev[itemId] || { verifiedQty: 0, controlled: false, pendingReason: '' };
      const nextControlled = !current.controlled;
      return {
        ...prev,
        [itemId]: {
          ...current,
          controlled: nextControlled,
          // Al despintar el control la línea queda pendiente y se registra un
          // motivo; al volver a controlarla el motivo deja de aplicar.
          pendingReason: nextControlled ? '' : current.pendingReason || PENDING_REASON_UNCONTROLLED,
        },
      };
    });
  };

  const handleQtyChange = (itemId: string, val: string, requestedQuantity: number) => {
    pinActiveLine(itemId);
    markManualPickingEdit();
    const qty = parseInt(val) || 0;
    setItemsState((prev) => ({
      ...prev,
      [itemId]: setPickingLineQuantity(prev[itemId], qty, requestedQuantity),
    }));
  };

  /**
   * Steppers móviles: actualización relativa para no perder toques rápidos.
   * Ajustar la cantidad también confirma el control de la línea.
   */
  const handleQtyDelta = (itemId: string, delta: number, requestedQuantity: number) => {
    pinActiveLine(itemId);
    markManualPickingEdit();
    setItemsState((prev) => ({
      ...prev,
      [itemId]: applyPickingQuantityDelta(prev[itemId], delta, requestedQuantity),
    }));
  };

  /** Atajo "= Solicitado": controla la línea completa en un solo toque. */
  const handleRequestedShortcut = (itemId: string, requestedQuantity: number) => {
    pinActiveLine(itemId);
    markManualPickingEdit();
    setItemsState((prev) => ({
      ...prev,
      [itemId]: markPickingLineRequested(requestedQuantity),
    }));
  };

  /** Atajo "Sin stock": deja la línea pendiente y enfoca el motivo sugerido. */
  const handleOutOfStockShortcut = (itemId: string) => {
    pinActiveLine(itemId);
    markManualPickingEdit();
    setItemsState((prev) => ({
      ...prev,
      [itemId]: markPickingLineOutOfStock(),
    }));

    requestAnimationFrame(() => mobileReasonRefs.current[itemId]?.focus());
  };

  const handlePendingReasonChange = (itemId: string, value: string) => {
    pinActiveLine(itemId);
    markManualPickingEdit();
    setItemsState((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        pendingReason: value,
      },
    }));
  };

  const closeAddProductModal = useCallback(() => {
    setShowAddModal(false);
    setProductSearch('');
    setAddQuantity(1);
  }, []);

  const handleAddProductToOrder = (product: ProductCatalog, qtyToAdd: number) => {
    if (!order) return;

    const quantity = normalizeDepositAddQuantity(qtyToAdd);
    markManualPickingEdit();

    const existingItem = findDepositItemByProductId(order.items, product._id);
    if (existingItem) {
      const key = pickingItemKey(existingItem);
      const plan = planDepositExistingAddition(existingItem, itemsState[key], quantity);

      pinActiveLine(key);
      setOrder({
        ...order,
        items: order.items.map((item) =>
          item === existingItem
            ? {
                ...item,
                requestedQuantity: plan.requestedQuantity,
                verifiedQuantity: plan.verifiedQuantity,
                lineTotal: isDepositAddedLine(item)
                  ? depositLineTotal(item.unitPrice, item.itemDiscount, plan.requestedQuantity)
                  : item.lineTotal,
              }
            : item,
        ),
      });
      setItemsState((prev) => ({ ...prev, [key]: plan.state }));

      closeAddProductModal();
      showToast(`Se sumaron ${quantity} u. a ${product.name}`, 'success');
      return;
    }

    const newItem = buildDepositAddedItem(product, order.clientId, quantity);
    const key = pickingItemKey(newItem);

    pinActiveLine(key);
    setOrder({ ...order, items: [...order.items, newItem] });
    setItemsState((prev) => ({
      ...prev,
      [key]: {
        verifiedQty: quantity,
        controlled: true,
        pendingReason: '',
      },
    }));

    closeAddProductModal();
    showToast(`Se agregaron ${quantity} u. de ${product.name}`, 'success');
  };

  const handleRemoveItem = (itemId: string, productId?: string) => {
    if (!order) return;

    const stateKey = itemId || productId;
    if (stateKey) pinActiveLine(stateKey);
    markManualPickingEdit();

    const matchesItem = (item: OrderItem) =>
      itemId && item._id ? item._id === itemId : item.productId?._id === productId;

    // No se borra la línea: se deja como pendiente para conservar el registro
    // del faltante/backorder y que facturación pueda verlo.
    setOrder({
      ...order,
      items: order.items.map((item) =>
        matchesItem(item)
          ? {
              ...item,
              verifiedQuantity: 0,
              isPending: true,
              pendingReason: PENDING_REASON_REMOVED,
              lineTotal: 0,
            }
          : item,
      ),
    });

    if (stateKey) {
      setItemsState((prev) => ({
        ...prev,
        [stateKey]: {
          verifiedQty: 0,
          controlled: false,
          pendingReason: PENDING_REASON_REMOVED,
        },
      }));
    }
  };

  /**
   * Guarda solo el comentario: no toca `itemsState` ni navega, así el control
   * en curso sigue intacto. La versión devuelta se conserva para el próximo
   * guardado del picking.
   */
  const handleSaveComment = async () => {
    if (!order || savingComment) return;

    const commentText = newComment.trim();
    if (!commentText) return;

    setSavingComment(true);

    try {
      const data = await apiRequest<OrderMutationResponse>(`/api/orders/${id}`, {
        method: 'PUT',
        body: {
          version: order.version ?? 0,
          comment: commentText,
        },
      });

      setOrder((prev) =>
        prev
          ? {
              ...prev,
              version: data.order.version ?? prev.version,
              comments: data.order.comments ?? [
                ...(prev.comments ?? []),
                {
                  text: commentText,
                  author: prev.createdBy,
                  role: 'deposit',
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );

      setNewComment('');
      showToast('¡Comentario agregado exitosamente!', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Error al guardar el comentario', 'error');
    } finally {
      setSavingComment(false);
    }
  };

  const handleSavePicking = async (targetStatus?: string) => {
    if (!order || submitting) return;

    setSubmitting(true);

    const updatedItems = order.items.map((item) => {
      const key = pickingItemKey(item);
      const state = itemsState[key] || {
        verifiedQty: item.requestedQuantity,
        controlled: false,
        pendingReason: item.pendingReason ?? '',
      };

      const finalVerifiedQty = state.controlled ? state.verifiedQty : 0;
      const isPending = !state.controlled;
      const leavesPending = isPending || finalVerifiedQty < item.requestedQuantity;
      const pendingReason = leavesPending
        ? state.pendingReason.trim() ||
          (isPending
            ? PENDING_REASON_UNCONTROLLED
            : `Faltante: ${finalVerifiedQty} de ${item.requestedQuantity} controlados`)
        : undefined;

      return {
        _id: item._id,
        productId: item.productId?._id,
        requestedQuantity: item.requestedQuantity,
        verifiedQuantity: finalVerifiedQty,
        isPending,
        pendingReason,
      };
    });

    const payload = {
      items: updatedItems,
      status: targetStatus,
      comment: newComment.trim(),
      version: order.version ?? 0,
    };

    // Si no hay red o el servidor no puede procesar el PUT, el body completo
    // queda en IndexedDB. El reintento conserva la versión leída, así que un
    // pedido modificado por otro operario se descarta con un 409 visible en
    // vez de pisar cambios.
    const saveLocally = async (message: string) => {
      try {
        await enqueuePendingOrderPut({
          orderId: id,
          url: `/api/orders/${id}`,
          body: payload,
          clientName: order.clientName,
          total: order.finalTotal,
        });
        setQueuedLocally(true);
        clearAutosaveAfterSave();
        void requestOrderPutBackgroundSync();
        showToast(message, 'success', 6000);
      } catch (queueError) {
        console.error('Error guardando el picking en IndexedDB:', queueError);
        showToast(
          'No se pudo guardar el picking localmente. Revisá el almacenamiento del navegador e intentá de nuevo.',
          'error',
          7000,
        );
      }
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await saveLocally(
          'Sin conexión: el picking quedó guardado en este dispositivo y se enviará al reconectar.',
        );
        return;
      }

      const data = await apiRequest<OrderMutationResponse>(`/api/orders/${id}`, {
        method: 'PUT',
        body: payload,
      });

      const nextStatus = data.order?.status ?? targetStatus;
      clearAutosaveAfterSave();
      if (data.order) {
        setOrder((prev) =>
          prev
            ? {
                ...prev,
                status: data.order.status ?? prev.status,
                version: data.order.version ?? prev.version,
              }
            : prev,
        );
      }
      showToast(
        `¡Picking guardado! Estado actual: ${nextStatus?.toUpperCase() ?? 'OK'}`,
        'success',
      );
      // El listado destino puede venir de la caché del Router con el estado
      // anterior al PUT. El marcador lo refresca en segundo plano al montar.
      markOrdersTrayForRefresh('/deposit/orders');
      startTransition(() => router.push('/deposit/orders'));
    } catch (err: unknown) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) {
          await saveLocally(
            'Tu sesión venció: el picking quedó guardado localmente. Iniciá sesión y reintentá la sincronización.',
          );
          return;
        }
        if (isRetriableOrderPutStatus(err.status)) {
          await saveLocally(
            'El servidor no respondió: el picking quedó guardado localmente y se reintentará.',
          );
          return;
        }
      }

      if (isNetworkError(err) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        await saveLocally(
          'Sin conexión: el picking quedó guardado en este dispositivo y se enviará al reconectar.',
        );
      } else {
        showToast(err instanceof Error ? err.message : 'Error al actualizar el picking', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <OrderDetailSkeleton variant="deposit" />;
  }

  if (!order) {
    return (
      <AppShell
        role={role}
        username={username}
        pageTitle="Control de pedido"
        backLabel="Volver"
        backHref={backHref}
      >
        <EmptyState
          icon={ClipboardCheck}
          title="No pudimos abrir el pedido"
          description={error ?? 'Pedido no encontrado'}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      role={role}
      username={username}
      pageTitle={`Pedido #${order._id.slice(-6)}`}
      pageDescription={order.clientName ?? order.clientId?.name}
      backLabel="Volver"
      backHref={backHref}
      bottomClearance="extra"
    >
      <div className="space-y-4 sm:space-y-6">
        {showStaleVersionBanner && (
          <OrderStaleVersionBanner
            currentVersion={currentVersion}
            latestVersion={pendingVersion}
            onLoadLatest={handleLoadLatestVersion}
          />
        )}

        {/* Info del cliente y botón de agregar producto */}
        <Card className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-action-soft text-action-text">
                <Building2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-foreground">
                  {order.clientName ?? order.clientId?.name}
                </h2>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  Código: {order.clientCode ?? order.clientId?.code}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">
              Dirección: {order.clientId?.address || 'N/A'}{' '}
              {order.clientId?.localidad
                ? `(${order.clientId.localidad}${order.clientId?.province ? `, ${order.clientId.province}` : ''})`
                : order.clientId?.province
                  ? `(${order.clientId.province})`
                  : ''}
            </p>
            <p className="mt-1 text-xs text-muted">
              Vendedor: <span className="font-semibold text-foreground">{order.createdBy}</span>
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:justify-end">
            <StatusBadge variant="deposit" status={order.status} />
            <OrderShareButtons order={order} hideLabelOnMobile />
            <OrderPrintLink href={`/deposit/orders/${id}/print`} hideLabelOnMobile />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setAddQuantity(1);
                setShowAddModal(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Agregar Producto
            </Button>
          </div>
        </Card>

        {restorableSnapshot && (
          <Card
            className="border-status-draft-border bg-status-draft-soft"
            data-testid="picking-restore-banner"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-status-draft">
                  Control sin guardar en este dispositivo
                </h3>
                <p className="mt-1 text-xs text-status-draft">
                  Hay avances del picking de hace menos de 24 h para la versión{' '}
                  {restorableSnapshot.version} del pedido. Podés retomarlos o descartarlos.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" onClick={handleDiscardAutosave}>
                  Descartar
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleRestoreAutosave}
                  data-testid="picking-restore-button"
                >
                  Restaurar control
                </Button>
              </div>
            </div>
          </Card>
        )}

        <Card data-testid="picking-quick-control">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Zap className="h-4 w-4 text-action-text" aria-hidden="true" /> Control rápido
              </h3>
              <p
                className="mt-1 text-xs text-muted"
                role="status"
                data-testid="picking-pending-count"
              >
                {pendingPickingCount === 0
                  ? 'Todas las líneas están controladas.'
                  : `Quedan ${pendingPickingCount} ${pendingPickingCount === 1 ? 'línea sin controlar' : 'líneas sin controlar'}.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setConfirmQuickControlOpen(true)}
                disabled={quickControlCandidates === 0 || submitting}
                data-testid="picking-bulk-button"
              >
                <Zap className="h-4 w-4" aria-hidden="true" /> Marcar todo con cantidad pedida
              </Button>
              {quickUndo && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleUndoQuickControl}
                  data-testid="picking-undo-button"
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" /> Deshacer ({quickUndo.changed})
                </Button>
              )}
            </div>
          </div>
        </Card>

        {/* Comentarios y Observaciones */}
        <CommentsPanel
          comments={order.comments}
          value={newComment}
          onChange={setNewComment}
          variant="deposit"
          onSubmit={handleSaveComment}
          submitting={savingComment || submitting}
        />

        {/* Tabla de ítems para verificar */}
        <Card>
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Package className="h-4 w-4 text-action-text" aria-hidden="true" /> Listado de Productos
            a Controlar
          </h3>

          {showLineFilters && (
            <div className="mb-4 space-y-2" data-testid="deposit-line-filters">
              <OrderLineFilters
                counts={lineFilterCounts}
                filter={lineFilter}
                onFilterChange={handleLineFilterChange}
                query={lineSearch}
                onQueryChange={handleLineSearchChange}
              />
              <p className="text-[10px] text-muted" role="status">
                Mostrando {visibleItems.length} de {order.items.length} líneas
              </p>
            </div>
          )}

          <div className="space-y-4">
            {visibleItems.length === 0 && (
              <div className="rounded-lg border border-border bg-surface-muted px-4 py-8 text-center text-xs text-muted">
                {order.items.length === 0
                  ? 'Este pedido no tiene líneas. Agregá un producto para controlarlo.'
                  : 'No hay líneas que coincidan con el filtro.'}
              </div>
            )}

            {/* Mobile Card View (No horizontal scroll needed) */}
            <div className="block sm:hidden space-y-3">
              {visibleItems.map((item) => {
                const key = pickingItemKey(item);
                const state = itemsState[key] || {
                  verifiedQty: item.requestedQuantity,
                  controlled: false,
                  pendingReason: item.pendingReason ?? '',
                };
                const isRemoved = state.pendingReason === PENDING_REASON_REMOVED;
                const needsReason = !state.controlled || state.verifiedQty < item.requestedQuantity;
                const showQuickShortcuts = shouldShowPickingShortcuts(
                  state,
                  item.requestedQuantity,
                );
                const itemLabel = item.productName ?? item.productId?.name ?? 'producto';

                return (
                  <div
                    key={`mob-${key}`}
                    data-testid="deposit-item-card"
                    className={`p-4 rounded-lg border transition ${
                      state.controlled
                        ? 'bg-status-delivered-soft border-status-delivered-border'
                        : isRemoved
                          ? 'bg-status-blocked-soft border-status-blocked-border'
                          : 'bg-surface-muted border-border'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2 mb-2">
                      <div className="flex min-w-0 items-start gap-3">
                        <ProductThumbnail
                          src={item.productId?.imageUrl}
                          alt={itemLabel}
                          size={44}
                          className="shrink-0"
                        />
                        <div className="min-w-0">
                          <span className="font-mono text-xs text-muted">
                            {item.productCode ?? item.productId?.code}
                          </span>
                          <h4 className="font-medium text-sm mt-0.5 text-foreground">
                            {item.productName ?? item.productId?.name}
                          </h4>
                          <span className="text-[10px] text-status-draft">
                            {item.brandName ?? item.productId?.brandId?.name}
                          </span>
                          {isRemoved && (
                            <span className="block mt-1 text-[10px] font-semibold text-status-blocked">
                              Eliminado en depósito (queda como faltante)
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        type="button"
                        tone="red"
                        appearance="ghost"
                        size="icon-sm"
                        onClick={() =>
                          setItemToRemove({
                            itemId: item._id || '',
                            productId: item.productId?._id,
                            name: item.productName ?? item.productId?.name ?? 'Producto',
                          })
                        }
                        className="shrink-0"
                        title="Eliminar ítem"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>

                    <div className="flex items-center justify-between gap-3 py-3 my-3 border-y border-border">
                      <div className="shrink-0 text-center">
                        <span className="block text-[10px] uppercase font-semibold text-muted">
                          Solicitado
                        </span>
                        <span className="text-base font-bold text-foreground">
                          {item.requestedQuantity}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="block text-center text-[10px] uppercase font-semibold text-muted">
                          Cant. Verificada
                        </span>
                        <div className="mt-1 flex items-center justify-center gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => handleQtyDelta(key, -1, item.requestedQuantity)}
                            disabled={state.verifiedQty <= 0}
                            aria-label={`Restar una unidad de ${itemLabel}`}
                            className="h-11 w-11 shrink-0"
                          >
                            <Minus className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <input
                            type="number"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            min="0"
                            step={1}
                            value={state.verifiedQty}
                            aria-label={`Cantidad controlada de ${itemLabel}`}
                            onChange={(e) =>
                              handleQtyChange(key, e.target.value, item.requestedQuantity)
                            }
                            className="h-11 w-16 rounded-md border border-border-strong bg-field px-1 text-center text-base font-semibold text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => handleQtyDelta(key, 1, item.requestedQuantity)}
                            aria-label={`Sumar una unidad de ${itemLabel}`}
                            className="h-11 w-11 shrink-0"
                          >
                            <Plus className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    {showQuickShortcuts && (
                      <div
                        className="mb-3 flex flex-wrap gap-2"
                        data-testid="deposit-quick-shortcuts"
                      >
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => handleRequestedShortcut(key, item.requestedQuantity)}
                          className="rounded-full font-bold"
                        >
                          = Solicitado ({item.requestedQuantity})
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => handleOutOfStockShortcut(key)}
                          className="rounded-full font-semibold"
                        >
                          Sin stock (0)
                        </Button>
                      </div>
                    )}

                    {needsReason && (
                      <div className="mb-3">
                        <label className="block text-[10px] uppercase font-semibold mb-1 text-muted">
                          Motivo (opcional)
                        </label>
                        <input
                          ref={(element) => {
                            mobileReasonRefs.current[key] = element;
                          }}
                          type="text"
                          value={state.pendingReason}
                          onChange={(e) => handlePendingReasonChange(key, e.target.value)}
                          placeholder="Se completa automáticamente si lo dejás vacío"
                          maxLength={200}
                          className="w-full px-3 py-2 border rounded-lg text-xs focus:outline-none focus:border-focus bg-surface border-border-strong text-foreground   "
                        />
                        <p className="mt-1 text-[10px] text-muted">
                          Si lo dejás vacío, se registra el faltante con las cantidades controladas.
                        </p>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant={state.controlled ? 'primary' : 'secondary'}
                        fullWidth
                        onClick={() => handleToggleControlled(key)}
                        className="rounded-md py-2.5 text-xs font-semibold"
                      >
                        {state.controlled ? '✓ Controlado' : 'Marcar como Controlado'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop Table View */}
            {order.items.length > 0 && (
              <div className="hidden sm:block">
                <Table dense>
                  <TableHead>
                    <TableHeaderRow>
                      <TableHeaderCell>Código</TableHeaderCell>
                      <TableHeaderCell>Producto</TableHeaderCell>
                      <TableHeaderCell align="center">Solicitado</TableHeaderCell>
                      <TableHeaderCell align="center">Cant. Verificada</TableHeaderCell>
                      <TableHeaderCell align="center">Estado / Confirmación</TableHeaderCell>
                      <TableHeaderCell align="center">Acción</TableHeaderCell>
                    </TableHeaderRow>
                  </TableHead>
                  <TableBody>
                    {visibleItems.map((item) => {
                      const key = pickingItemKey(item);
                      const state = itemsState[key] || {
                        verifiedQty: item.requestedQuantity,
                        controlled: false,
                        pendingReason: item.pendingReason ?? '',
                      };
                      const isRemoved = state.pendingReason === PENDING_REASON_REMOVED;
                      const needsReason =
                        !state.controlled || state.verifiedQty < item.requestedQuantity;

                      return (
                        <TableRow
                          key={key}
                          className={`transition ${
                            state.controlled
                              ? 'bg-status-delivered-soft hover:brightness-95'
                              : isRemoved
                                ? 'bg-status-blocked-soft hover:brightness-95'
                                : 'hover:bg-surface-muted'
                          }`}
                        >
                          <TableCell className="font-mono text-xs text-foreground">
                            {item.productCode ?? item.productId?.code}
                          </TableCell>
                          <TableCell className="font-medium text-foreground">
                            <div className="flex items-center gap-3">
                              <ProductThumbnail
                                src={item.productId?.imageUrl}
                                alt={item.productName ?? item.productId?.name ?? 'Producto'}
                                size={44}
                                className="shrink-0"
                              />
                              <div className="min-w-0">
                                {item.productName ?? item.productId?.name}
                                <span className="block text-[10px] text-status-draft">
                                  {item.brandName ?? item.productId?.brandId?.name}
                                </span>
                                {isRemoved && (
                                  <span className="block mt-1 text-[10px] font-semibold text-status-blocked">
                                    Eliminado en depósito (queda como faltante)
                                  </span>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell align="center" className="font-bold text-foreground">
                            {item.requestedQuantity}
                          </TableCell>
                          <TableCell align="center">
                            <input
                              type="number"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              min="0"
                              step={1}
                              value={state.verifiedQty}
                              aria-label={`Cantidad controlada de ${item.productName ?? item.productId?.name ?? 'producto'}`}
                              onChange={(e) =>
                                handleQtyChange(key, e.target.value, item.requestedQuantity)
                              }
                              className="h-9 w-20 rounded-md border border-border-strong bg-field px-2 text-center text-sm font-semibold text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
                            />
                          </TableCell>
                          <TableCell align="center">
                            <Button
                              type="button"
                              variant={state.controlled ? 'primary' : 'secondary'}
                              size="sm"
                              onClick={() => handleToggleControlled(key)}
                              className="px-4 py-1.5 text-xs font-semibold"
                            >
                              {state.controlled ? '✓ Controlado' : 'Controlado'}
                            </Button>
                            {needsReason && (
                              <div className="mt-2">
                                <label className="block text-[10px] uppercase font-semibold text-muted">
                                  Motivo (opcional)
                                </label>
                                <input
                                  type="text"
                                  value={state.pendingReason}
                                  onChange={(e) => handlePendingReasonChange(key, e.target.value)}
                                  placeholder="Se completa automáticamente si lo dejás vacío"
                                  maxLength={200}
                                  className="mt-1 w-48 rounded-md border border-border-strong bg-field px-2 py-1 text-[11px] text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
                                />
                                <p className="mt-1 text-[10px] text-muted">
                                  Si lo dejás vacío, se registra el faltante con las cantidades
                                  controladas.
                                </p>
                              </div>
                            )}
                          </TableCell>
                          <TableCell align="center">
                            <Button
                              type="button"
                              tone="red"
                              appearance="ghost"
                              size="icon-sm"
                              onClick={() =>
                                setItemToRemove({
                                  itemId: item._id || '',
                                  productId: item.productId?._id,
                                  name: item.productName ?? item.productId?.name ?? 'Producto',
                                })
                              }
                              title="Eliminar ítem"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Botones de acción final de depósito (escritorio; en mobile van en la barra fija) */}
          <div className="mt-8 flex flex-col gap-4 pt-4 border-t border-border">
            {queuedLocally && (
              <div
                className="flex items-center gap-2 rounded-lg border border-status-draft-border bg-status-draft-soft px-3 py-2 text-xs font-medium text-status-draft"
                role="status"
              >
                <CloudUpload className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Picking guardado en el dispositivo. Pendiente de sincronización.</span>
              </div>
            )}
            <div className="hidden lg:flex flex-col sm:flex-row gap-4 justify-end items-stretch sm:items-center">
              <Button
                variant="destructive"
                onClick={() => handleSavePicking('paralizado')}
                disabled={submitting || isNavigating}
                className="rounded-md px-6 py-3 text-sm"
              >
                Paralizar Pedido (Faltantes / Esperar Stock)
              </Button>
              <Button
                variant="primary"
                size="lg"
                onClick={() => handleSavePicking('facturacion')}
                disabled={submitting || isNavigating}
                className="px-6 py-3"
              >
                {submitting ? 'Guardando...' : 'Aprobar y Enviar a Facturación'}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Barra fija inferior de mobile: una mano, siempre a la vista. */}
      <div
        data-testid="deposit-action-bar"
        aria-hidden={inputFocused || undefined}
        inert={inputFocused || undefined}
        className={`fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-elevation-2 backdrop-blur-md transition-all duration-200 motion-reduce:transition-none lg:hidden ${
          inputFocused
            ? 'translate-y-full opacity-0 pointer-events-none'
            : 'translate-y-0 opacity-100'
        }`}
      >
        <div className="min-w-0">
          <p className="text-[10px] uppercase font-semibold text-muted">Pendientes</p>
          <p
            className={`text-lg font-extrabold ${
              pendingPickingCount > 0 ? 'text-status-draft' : 'text-status-delivered'
            }`}
            data-testid="deposit-mobile-pending-count"
            role="status"
          >
            {pendingPickingCount}
          </p>
        </div>
        <div className="flex min-w-0 flex-1 justify-end gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handleSavePicking('paralizado')}
            disabled={submitting || isNavigating}
            className="max-w-36 flex-1 px-3 py-2.5 text-xs font-semibold"
          >
            Paralizar
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleSavePicking('facturacion')}
            disabled={submitting || isNavigating}
            className="max-w-44 flex-1 px-3 py-2.5 text-xs font-semibold"
          >
            {submitting ? 'Guardando...' : 'Aprobar'}
          </Button>
        </div>
      </div>

      {/* Modal para Agregar Producto */}
      <Modal
        open={showAddModal}
        onClose={closeAddProductModal}
        labelledBy={addProductTitleId}
        variant="responsive"
        initialFocusRef={addProductSearchRef}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 id={addProductTitleId} className="text-base font-semibold text-foreground">
            Agregar Producto al Pedido
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={closeAddProductModal}
            aria-label="Cerrar modal de productos"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="mb-3 flex items-center gap-2 rounded-md border border-border-strong bg-field px-3 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/30">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={addProductSearchRef}
            type="text"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="Buscar por código o nombre..."
            className="h-11 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none sm:h-9 sm:text-xs"
            autoFocus
          />
          {productSearch && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setProductSearch('');
                addProductSearchRef.current?.focus();
              }}
              aria-label="Limpiar búsqueda de productos"
              className="h-11 w-11 shrink-0"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>

        <div className="mb-4 rounded-lg border border-border bg-surface-muted p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="block text-[10px] font-semibold uppercase text-muted">
                Cantidad a agregar
              </span>
              <QuantityStepper
                value={addQuantity}
                onChange={setAddQuantity}
                min={1}
                label="Cantidad a agregar"
                className="mt-1.5"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddQuantity((quantity) => quantity + 6)}
                title="Sumar 6 unidades"
              >
                +6
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddQuantity((quantity) => quantity + 12)}
                title="Sumar 12 unidades"
              >
                +12
              </Button>
            </div>
          </div>
        </div>

        {catalogFromCache && (
          <OfflineCatalogBadge className="mb-3" detail="catálogo de productos" />
        )}

        <div className="max-h-72 divide-y divide-border space-y-1 overflow-y-auto">
          {loadingCatalog && catalogProducts.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted">Cargando catálogo...</div>
          ) : catalogProducts.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted">
              No se encontraron productos para la búsqueda.
            </div>
          ) : (
            catalogProducts.map((p) => (
              <button
                key={p._id}
                type="button"
                onClick={() => handleAddProductToOrder(p, addQuantity)}
                className="flex w-full items-center gap-3 rounded-lg p-3 text-left text-xs text-foreground transition hover:bg-action-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <ProductThumbnail src={p.imageUrl} alt={p.name} size={44} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words">
                    <strong className="font-mono text-action-text">{p.code}</strong> - {p.name}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted">
                    Marca: {p.brandId?.name} | s/IVA: ${p.price.toFixed(2)} | c/IVA: $
                    {(p.priceWithIva || p.price * 1.21).toFixed(2)}
                  </span>
                </span>
                <span className="shrink-0 rounded-lg bg-action px-2.5 py-1 font-medium text-white">
                  Agregar
                </span>
              </button>
            ))
          )}
          {catalogProducts.length >= 30 && (
            <div className="py-2 text-center text-[10px] text-muted">
              Mostrando los primeros 30 resultados. Refina la búsqueda para encontrar más productos.
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmQuickControlOpen}
        title="Marcar todo con cantidad pedida"
        message={`Se van a controlar ${quickControlCandidates} ${
          quickControlCandidates === 1 ? 'línea pendiente' : 'líneas pendientes'
        } con la cantidad pedida. Las líneas ya controladas y las eliminadas no se modifican. Después podés deshacerlo.`}
        confirmLabel="Marcar todo"
        variant="primary"
        onClose={() => setConfirmQuickControlOpen(false)}
        onConfirm={handleQuickControl}
      />

      <ConfirmDialog
        open={itemToRemove !== null}
        title="Eliminar producto del pedido"
        message={
          itemToRemove
            ? `¿Marcar "${itemToRemove.name}" como eliminado/faltante? La línea quedará registrada como pendiente para facturación.`
            : ''
        }
        confirmLabel="Marcar faltante"
        variant="danger"
        onClose={() => setItemToRemove(null)}
        onConfirm={() => {
          if (itemToRemove) handleRemoveItem(itemToRemove.itemId, itemToRemove.productId);
        }}
      />
    </AppShell>
  );
}
