'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search, Users, X } from 'lucide-react';
import AppShell from '@/components/app-shell/AppShell';
import OfflineCatalogBadge from '@/components/orders/new/OfflineCatalogBadge';
import OfflineCatalogSyncProgress from '@/components/orders/new/OfflineCatalogSyncProgress';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
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
import { CLIENTS_PAGE_SIZE } from '@/lib/catalog-pagination';
import { countSelectedItems } from '@/lib/order-catalog';
import { loadOrderDraft, type OrderDraftStorage } from '@/lib/order-draft';
import { searchOfflineCatalogClients } from '@/lib/offline-catalog';
import {
  isBrowserOffline,
  rememberOfflineCatalogBrands,
  rememberOfflineCatalogClients,
  syncOfflineCatalog,
} from '@/lib/offline-catalog-sync';
import type { BrandDTO, ClientDTO } from '@/lib/types';
import CatalogTabs from '../CatalogTabs';

interface ClientsBrowserProps {
  initialClients: ClientDTO[];
  brands: BrandDTO[];
  initialSearch: string;
  page: number;
  total: number;
  totalPages: number;
  role: UserRole;
  username: string;
}

const SEARCH_PLACEHOLDER = 'Buscar por código, nombre, dirección o localidad...';

interface LocalClientsPage {
  items: ClientDTO[];
  total: number;
  page: number;
  totalPages: number;
}

function buildClientsUrl(page: number, search: string): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (search) params.set('search', search);

  const queryString = params.toString();
  return queryString ? `/catalog/clients?${queryString}` : '/catalog/clients';
}

function getBrowserDraftStorage(): OrderDraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function brandDiscountLabel(
  discount: { brandId: string; discountPercentage: number },
  brands: BrandDTO[],
): string {
  const brand = brands.find((candidate) => candidate._id === discount.brandId);
  return `${brand?.name || 'Marca'} ${discount.discountPercentage}%`;
}

function formatBrandDiscounts(client: ClientDTO, brands: BrandDTO[]): string {
  if (!client.brandDiscounts || client.brandDiscounts.length === 0) return '—';

  return client.brandDiscounts.map((discount) => brandDiscountLabel(discount, brands)).join(' · ');
}

/**
 * Catálogo de clientes para vendedores y controladores. Con red, la búsqueda y
 * la paginación navegan con la URL y el Server Component consulta la base. Sin
 * red, se resuelven contra el snapshot de IndexedDB. Vendedores y admins pueden
 * iniciar un pedido con el cliente ya seleccionado.
 */
export default function ClientsBrowser({
  initialClients,
  brands,
  initialSearch,
  page: serverPage,
  total: serverTotal,
  totalPages: serverTotalPages,
  role,
  username,
}: ClientsBrowserProps) {
  const { user } = useUser();
  const userId = user?.id ?? '';
  const [search, setSearch] = useState(initialSearch);
  const [isPending, startTransition] = useTransition();
  const [isOffline, setIsOffline] = useState(false);
  const [offlinePage, setOfflinePage] = useState<LocalClientsPage | null>(null);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [draftItemCount, setDraftItemCount] = useState(0);
  const offlineRequestRef = useRef(0);
  const pendingOfflinePageRef = useRef(1);
  const router = useRouter();
  const canCreateOrder = user?.role === 'admin' || user?.role === 'vendedor';

  // El borrador es compartido con /catalog y /orders/new vía localStorage. Se
  // relee al entrar a la pestaña para que el botón refleje el carrito que el
  // vendedor ya viene armando.
  useEffect(() => {
    if (!canCreateOrder || !userId) {
      setDraftItemCount(0);
      return;
    }

    const saved = loadOrderDraft(getBrowserDraftStorage(), userId);
    setDraftItemCount(countSelectedItems(saved?.quantities ?? {}).distinct);
  }, [canCreateOrder, userId]);

  const orderButtonLabel =
    draftItemCount > 0 ? `Usar en pedido (${draftItemCount} ítems)` : 'Crear pedido';

  const clients = offlinePage ? offlinePage.items : initialClients;
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

  /** Resuelve una página de clientes contra el snapshot local. */
  const loadLocalPage = useCallback(
    async (targetPage: number, term: string) => {
      if (!userId) return;

      const ticket = ++offlineRequestRef.current;
      setOfflineLoading(true);

      try {
        const query = {
          limit: CLIENTS_PAGE_SIZE,
          offset: (targetPage - 1) * CLIENTS_PAGE_SIZE,
        };
        let result = await searchOfflineCatalogClients(userId, term, query);
        if (ticket !== offlineRequestRef.current) return;

        let resolvedPage = targetPage;
        let resolvedTotalPages = Math.max(1, Math.ceil(result.total / CLIENTS_PAGE_SIZE));

        if (targetPage > resolvedTotalPages) {
          resolvedPage = resolvedTotalPages;
          result = await searchOfflineCatalogClients(userId, term, {
            ...query,
            offset: (resolvedPage - 1) * CLIENTS_PAGE_SIZE,
          });
          if (ticket !== offlineRequestRef.current) return;
          resolvedTotalPages = Math.max(1, Math.ceil(result.total / CLIENTS_PAGE_SIZE));
        }

        setOfflinePage({
          items: result.items as ClientDTO[],
          total: result.total,
          page: resolvedPage,
          totalPages: resolvedTotalPages,
        });
      } catch (error) {
        console.error('Error consultando los clientes guardados:', error);
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

  // Detecta la falta de red y pasa a resolver búsqueda/paginación localmente.
  useEffect(() => {
    let cancelled = false;

    const activateOffline = () => {
      if (cancelled) return;

      const params = new URLSearchParams(window.location.search);
      const nextSearch = (params.get('search') || '').trim();
      const parsedPage = Number.parseInt(params.get('page') || '1', 10);

      pendingOfflinePageRef.current =
        Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      setSearch(nextSearch);
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
  }, [requestAutoCatalogSync, router]);

  useEffect(() => {
    if (!isOffline) return;

    const targetPage = pendingOfflinePageRef.current;
    pendingOfflinePageRef.current = 1;
    const trimmed = search.trim();
    const timer = window.setTimeout(
      () => {
        void loadLocalPage(targetPage, trimmed);
      },
      trimmed ? 250 : 0,
    );

    return () => window.clearTimeout(timer);
  }, [isOffline, search, loadLocalPage]);

  // Visitar el catálogo online también precalienta el snapshot del dispositivo.
  useEffect(() => {
    if (!userId || isOffline) return;
    rememberOfflineCatalogClients(userId, initialClients);
    rememberOfflineCatalogBrands(userId, brands);
  }, [userId, isOffline, initialClients, brands]);

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

  // Búsqueda con debounce: con red la consulta real la hace el Server Component.
  useEffect(() => {
    if (isOffline) return;

    const trimmed = search.trim();
    if (trimmed === initialSearch) return;

    const timer = setTimeout(
      () => {
        markSearchCommitted(trimmed);
        startTransition(() => {
          router.replace(buildClientsUrl(1, trimmed));
        });
      },
      trimmed ? 300 : 0,
    );

    return () => clearTimeout(timer);
  }, [search, initialSearch, router, isOffline, markSearchCommitted]);

  const goToPage = (targetPage: number) => {
    if (targetPage < 1 || targetPage > totalPages || targetPage === page) return;

    if (isOffline) {
      void loadLocalPage(targetPage, search.trim());
      return;
    }

    markSearchCommitted(search);
    startTransition(() => {
      router.push(buildClientsUrl(targetPage, search.trim()));
    });
  };

  const openNewOrder = (clientId: string) => {
    const href = `/orders/new?clientId=${encodeURIComponent(clientId)}`;
    // Sin red, una navegación RSC fallaría; el documento completo lo sirve el
    // service worker desde PAGE_CACHE y el alta resuelve el cliente en IDB.
    if (isOffline) {
      // Navegación completa a propósito: sin red un RSC fetch fallaría y el SW
      // necesita servir el documento cacheado de /orders/new.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(href);
      return;
    }
    router.push(href);
  };

  const emptyMessage = search.trim()
    ? 'No se encontraron clientes que coincidan con la búsqueda.'
    : busy
      ? 'Cargando clientes...'
      : isOffline
        ? 'No hay clientes guardados en este dispositivo.'
        : 'No hay clientes disponibles en el catálogo.';

  return (
    <AppShell
      role={role}
      username={username}
      pageTitle="Clientes"
      pageDescription="Clientes, direcciones y descuentos del catálogo."
    >
      <CatalogTabs active="clients" />
      <OfflineCatalogSyncProgress className="mb-4" />
      {isOffline && <OfflineCatalogBadge className="mb-4" detail="catálogo de clientes" />}
      <Card className="flex flex-col">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-action-soft p-3 text-action-text">
              <Users className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Catálogo de Clientes</h2>
              <p className="text-xs text-muted">
                {search.trim()
                  ? `Mostrando ${clients.length} de ${total} clientes`
                  : `Total de clientes: ${total}`}
              </p>
            </div>
          </div>
          <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-muted">
            Solo lectura
          </span>
        </div>

        <div className="relative mb-4">
          <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-subtle">
            <Search className="h-4 w-4" aria-hidden="true" />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Buscar clientes por código, nombre, dirección o localidad"
            className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-12 text-base text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Limpiar búsqueda de clientes"
              title="Limpiar búsqueda"
              className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <div
          className={`flex-1 transition-opacity ${busy ? 'opacity-60' : 'opacity-100'}`}
          aria-busy={busy}
        >
          {/* En mobile cada cliente se lee como tarjeta con sus descuentos. */}
          <div data-testid="catalog-client-cards" className="block space-y-3 sm:hidden">
            {clients.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted">{emptyMessage}</div>
            ) : (
              clients.map((client) => (
                <div
                  key={`mob-${client._id}`}
                  className="cv-list-item cv-client-card space-y-3 rounded-lg border border-border bg-surface-muted p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-mono text-xs font-semibold text-action-text">
                        {client.code}
                      </span>
                      <p className="mt-0.5 break-words text-sm font-semibold text-foreground">
                        {client.name}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {client.address || 'Sin dirección'}
                        {client.localidad
                          ? ` · ${client.localidad}${client.province ? `, ${client.province}` : ''}`
                          : client.province
                            ? ` · ${client.province}`
                            : ''}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-xs font-semibold text-foreground ring-1 ring-border">
                      {client.generalDiscount}% desc.
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {client.brandDiscounts && client.brandDiscounts.length > 0 ? (
                      client.brandDiscounts.map((discount) => (
                        <span
                          key={`${client._id}-${discount.brandId}`}
                          className="inline-flex rounded-full bg-action-soft px-2 py-1 text-[11px] font-medium text-action-text"
                        >
                          {brandDiscountLabel(discount, brands)}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-subtle">Sin descuentos por marca</span>
                    )}
                  </div>

                  {canCreateOrder && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      fullWidth
                      onClick={() => openNewOrder(client._id)}
                    >
                      {orderButtonLabel}
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="hidden sm:block">
            <Table dense>
              <TableHead>
                <TableHeaderRow>
                  <TableHeaderCell>Código</TableHeaderCell>
                  <TableHeaderCell>Cliente</TableHeaderCell>
                  <TableHeaderCell>Dirección</TableHeaderCell>
                  <TableHeaderCell>Localidad / Provincia</TableHeaderCell>
                  <TableHeaderCell align="right">Desc. General</TableHeaderCell>
                  <TableHeaderCell>Desc. por Marca</TableHeaderCell>
                  {canCreateOrder && <TableHeaderCell align="right">Acciones</TableHeaderCell>}
                </TableHeaderRow>
              </TableHead>
              <TableBody>
                {clients.length === 0 ? (
                  <TableEmptyRow colSpan={canCreateOrder ? 7 : 6}>{emptyMessage}</TableEmptyRow>
                ) : (
                  clients.map((client) => (
                    <TableRow key={client._id} hover>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted">
                        {client.code}
                      </TableCell>
                      <TableCell className="text-foreground">{client.name}</TableCell>
                      <TableCell className="text-muted">{client.address || '—'}</TableCell>
                      <TableCell className="text-muted">
                        {client.localidad || '—'}
                        {client.province ? `, ${client.province}` : ''}
                      </TableCell>
                      <TableCell
                        align="right"
                        className="font-semibold tabular-nums text-foreground"
                      >
                        {client.generalDiscount}%
                      </TableCell>
                      <TableCell className="text-xs text-muted">
                        {formatBrandDiscounts(client, brands)}
                      </TableCell>
                      {canCreateOrder && (
                        <TableCell align="right">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => openNewOrder(client._id)}
                            className="whitespace-nowrap"
                          >
                            {orderButtonLabel}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
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
    </AppShell>
  );
}
