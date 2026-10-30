'use client';

import { useState, useEffect, useId, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users,
  Pencil,
  Trash2,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  Percent,
  Sparkles,
} from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
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
import { buildClientCodeSuggestion } from '@/lib/client-code';
import type { BrandDTO, ClientDTO, ClientMutationResponse, DeleteResponse } from '@/lib/types';

interface ClientsManagerProps {
  initialClients: ClientDTO[];
  brands: BrandDTO[];
  initialSearch: string;
  page: number;
  total: number;
  totalPages: number;
}

function buildClientsUrl(page: number, search: string): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (search) params.set('search', search);

  const queryString = params.toString();
  return queryString ? `/backoffice/clients?${queryString}` : '/backoffice/clients';
}

/**
 * Interacciones del backoffice de clientes. Los datos de la cartera y las
 * marcas llegan resueltos del Server Component; búsqueda y paginación viven en
 * la URL para que el servidor consulte la base con la caché correspondiente.
 */
export default function ClientsManager({
  initialClients,
  brands,
  initialSearch,
  page,
  total,
  totalPages,
}: ClientsManagerProps) {
  const [clients, setClients] = useState<ClientDTO[]>(initialClients);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [localidad, setLocalidad] = useState('');
  const [province, setProvince] = useState('');
  const [generalDiscount, setGeneralDiscount] = useState('');

  const [brandDiscounts, setBrandDiscounts] = useState<
    { brandId: string; discountPercentage: number }[]
  >([]);
  const [selectedBrandId, setSelectedBrandId] = useState('');
  const [brandDiscountPct, setBrandDiscountPct] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [search, setSearch] = useState(initialSearch);
  const [isPending, startTransition] = useTransition();
  const formCardRef = useRef<HTMLDivElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Edición rápida de descuentos desde la tarjeta/fila, sin perder el scroll.
  const [discountEditorClient, setDiscountEditorClient] = useState<ClientDTO | null>(null);
  const [quickGeneralDiscount, setQuickGeneralDiscount] = useState('');
  const [quickBrandDiscounts, setQuickBrandDiscounts] = useState<
    { brandId: string; discountPercentage: number }[]
  >([]);
  const [quickSelectedBrandId, setQuickSelectedBrandId] = useState('');
  const [quickBrandDiscountPct, setQuickBrandDiscountPct] = useState('');
  const [quickDiscountSaving, setQuickDiscountSaving] = useState(false);
  const quickDiscountInputRef = useRef<HTMLInputElement>(null);
  const quickDiscountTitleId = useId();
  const quickDiscountDescriptionId = useId();
  const quickGeneralDiscountId = useId();
  const quickBrandSelectId = useId();
  const quickBrandPctId = useId();

  const { showToast } = useToast();
  const router = useRouter();

  // El listado puede cambiar por navegación o por un refresh del servidor.
  useEffect(() => {
    setClients(initialClients);
  }, [initialClients]);

  // Mantiene el input alineado con la URL (atrás/adelante, refresh del server).
  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  // Búsqueda con debounce: la consulta real la hace el Server Component.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === initialSearch) return;

    const timer = setTimeout(
      () => {
        startTransition(() => {
          router.replace(buildClientsUrl(1, trimmed));
        });
      },
      trimmed ? 300 : 0,
    );

    return () => clearTimeout(timer);
  }, [search, initialSearch, router]);

  const handleAddBrandDiscount = () => {
    if (!selectedBrandId) return;
    const pct = parseFloat(brandDiscountPct) || 0;
    setBrandDiscounts((prev) => {
      const exists = prev.findIndex((b) => b.brandId === selectedBrandId);
      if (exists >= 0) {
        const copy = [...prev];
        copy[exists] = { brandId: selectedBrandId, discountPercentage: pct };
        return copy;
      }
      return [...prev, { brandId: selectedBrandId, discountPercentage: pct }];
    });
    setSelectedBrandId('');
    setBrandDiscountPct('');
  };

  const handleRemoveBrandDiscount = (brandId: string) => {
    setBrandDiscounts((prev) => prev.filter((b) => b.brandId !== brandId));
  };

  const handleSuggestCode = () => {
    if (editingId) return;
    setCode(buildClientCodeSuggestion());
    requestAnimationFrame(() => codeInputRef.current?.focus());
  };

  const openDiscountEditor = (client: ClientDTO) => {
    setDiscountEditorClient(client);
    setQuickGeneralDiscount(String(client.generalDiscount || 0));
    setQuickBrandDiscounts(
      client.brandDiscounts
        ? client.brandDiscounts.map((discount) => ({
            brandId: discount.brandId,
            discountPercentage: discount.discountPercentage,
          }))
        : [],
    );
    setQuickSelectedBrandId('');
    setQuickBrandDiscountPct('');
  };

  const closeDiscountEditor = () => {
    if (quickDiscountSaving) return;
    setDiscountEditorClient(null);
  };

  const handleAddQuickBrandDiscount = () => {
    if (!quickSelectedBrandId) return;

    const percentage = Number.parseFloat(quickBrandDiscountPct) || 0;
    setQuickBrandDiscounts((prev) => {
      const existing = prev.findIndex((discount) => discount.brandId === quickSelectedBrandId);

      if (existing >= 0) {
        const next = [...prev];
        next[existing] = {
          brandId: quickSelectedBrandId,
          discountPercentage: percentage,
        };
        return next;
      }

      return [...prev, { brandId: quickSelectedBrandId, discountPercentage: percentage }];
    });
    setQuickSelectedBrandId('');
    setQuickBrandDiscountPct('');
  };

  const handleRemoveQuickBrandDiscount = (brandId: string) => {
    setQuickBrandDiscounts((prev) => prev.filter((discount) => discount.brandId !== brandId));
  };

  /**
   * Guarda los descuentos del cliente en su ficha sin navegar ni recargar la
   * página: la tarjeta se actualiza en memoria y conserva la posición del scroll.
   */
  const handleQuickDiscountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const client = discountEditorClient;
    if (!client) return;

    const generalDiscountValue = Number(quickGeneralDiscount) || 0;
    if (
      !Number.isFinite(generalDiscountValue) ||
      generalDiscountValue < 0 ||
      generalDiscountValue > 100
    ) {
      showToast('Ingresá un descuento general entre 0 y 100', 'error');
      return;
    }

    setQuickDiscountSaving(true);
    try {
      const data = await api.put<ClientMutationResponse>(`/api/clients/${client._id}`, {
        code: client.code,
        name: client.name,
        address: client.address || '',
        localidad: client.localidad || '',
        province: client.province || '',
        generalDiscount: generalDiscountValue,
        brandDiscounts: quickBrandDiscounts.map((discount) => ({
          brandId: discount.brandId,
          discountPercentage: Number(discount.discountPercentage) || 0,
        })),
      });

      const updatedClient = data.client;
      setClients((prev) =>
        prev.map((item) => (item._id === updatedClient._id ? updatedClient : item)),
      );
      invalidateCatalogCache('clients');
      showToast(data.message || 'Descuentos actualizados exitosamente', 'success');
      setDiscountEditorClient(null);
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setQuickDiscountSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const url = editingId ? `/api/clients/${editingId}` : '/api/clients';
      const body = {
        code,
        name,
        address,
        localidad,
        province,
        generalDiscount: Number(generalDiscount) || 0,
        brandDiscounts: brandDiscounts.map((bd) => ({
          brandId: bd.brandId,
          discountPercentage: Number(bd.discountPercentage) || 0,
        })),
      };

      const data = editingId
        ? await api.put<ClientMutationResponse>(url, body)
        : await api.post<ClientMutationResponse>(url, body);

      showToast(data.message || 'Cliente guardado exitosamente', 'success');
      invalidateCatalogCache('clients');
      resetForm();
      router.refresh();
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (client: ClientDTO) => {
    setEditingId(client._id);
    setCode(client.code);
    setName(client.name);
    setAddress(client.address || '');
    setLocalidad(client.localidad || '');
    setProvince(client.province || '');
    setGeneralDiscount(String(client.generalDiscount || 0));
    setBrandDiscounts(
      client.brandDiscounts
        ? client.brandDiscounts.map((bd) => ({
            brandId: bd.brandId,
            discountPercentage: bd.discountPercentage,
          }))
        : [],
    );

    // En mobile el formulario está arriba: llevamos al usuario hasta él y
    // enfocamos el primer campo para continuar la edición sin buscar a mano.
    requestAnimationFrame(() => {
      formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      codeInputRef.current?.focus({ preventScroll: true });
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setCode('');
    setName('');
    setAddress('');
    setLocalidad('');
    setProvince('');
    setGeneralDiscount('');
    setBrandDiscounts([]);
    setSelectedBrandId('');
    setBrandDiscountPct('');
  };

  const handleDelete = async (id: string) => {
    try {
      const data = await api.delete<DeleteResponse>(`/api/clients/${id}`);

      showToast(data.message || 'Cliente eliminado exitosamente', 'success');
      invalidateCatalogCache('clients');
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
      router.push(buildClientsUrl(targetPage, search.trim()));
    });
  };

  const emptyMessage = search.trim()
    ? 'No se encontraron clientes.'
    : isPending
      ? 'Cargando clientes...'
      : 'No hay clientes registrados aún.';

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        {/* Formulario */}
        <div ref={formCardRef} className="scroll-mt-24">
          <Card className={`h-fit transition-shadow ${editingId ? 'ring-2 ring-focus/40' : ''}`}>
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <Users className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {editingId ? 'Editar Cliente' : 'Nuevo Cliente'}
                </h2>
                <p className="text-xs text-muted">
                  {editingId ? 'Modificar datos del cliente' : 'Alta unitaria de cliente'}
                </p>
              </div>
            </div>

            {editingId && (
              <div
                role="status"
                aria-live="polite"
                data-testid="client-editing-indicator"
                className="mb-4 flex items-start gap-2 rounded-lg border border-action/30 bg-action-soft px-3 py-2 text-xs text-action-text"
              >
                <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  <span className="font-semibold">Editando</span>{' '}
                  {code ? `${code} · ${name}` : 'cliente seleccionado'}
                </span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Código de Cliente
                </label>
                <div className="flex items-stretch gap-2">
                  <input
                    ref={codeInputRef}
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    placeholder="Ej: CLI001"
                    className="min-h-11 min-w-0 flex-1 rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                  />
                  {!editingId && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleSuggestCode}
                      aria-label="Sugerir código"
                      className="shrink-0 self-stretch"
                    >
                      <Sparkles className="h-4 w-4" aria-hidden="true" />
                      <span className="max-[380px]:sr-only">Sugerir código</span>
                    </Button>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Nombre / Razón Social
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Ej: Supermercado El Ahorro"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Dirección
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Ej: Av. San Martín 1234"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Localidad
                </label>
                <input
                  type="text"
                  value={localidad}
                  onChange={(e) => setLocalidad(e.target.value)}
                  placeholder="Ej: Rosario"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Provincia
                </label>
                <input
                  type="text"
                  value={province}
                  onChange={(e) => setProvince(e.target.value)}
                  placeholder="Ej: Santa Fe"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Descuento General (%)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={generalDiscount}
                  onChange={(e) => setGeneralDiscount(e.target.value)}
                  placeholder="0"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30   "
                />
              </div>

              {/* Descuentos por Marca */}
              <div className="p-4 rounded-lg border bg-surface-muted border-border  ">
                <label className="mb-2 block text-xs font-semibold text-foreground">
                  Descuentos por Marca (Opcional)
                </label>

                <div className="space-y-2 mb-3">
                  {brandDiscounts.map((bd, idx) => {
                    const brandObj = brands.find((b) => b._id === bd.brandId);
                    return (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded-lg border border-border bg-surface p-2 text-xs text-foreground"
                      >
                        <span>{brandObj?.name || 'Marca desconocida'}</span>
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-foreground">
                            {bd.discountPercentage}%
                          </span>
                          <Button
                            type="button"
                            appearance="ghost"
                            tone="red"
                            size="icon-sm"
                            onClick={() => handleRemoveBrandDiscount(bd.brandId)}
                            title="Eliminar descuento de marca"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {brandDiscounts.length === 0 && (
                    <p className="text-[11px] text-muted italic">
                      No hay descuentos por marca configurados para este cliente.
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <select
                    value={selectedBrandId}
                    onChange={(e) => setSelectedBrandId(e.target.value)}
                    className="min-h-11 min-w-0 basis-full rounded-md border border-border-strong bg-field px-3 py-1.5 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30 sm:basis-0 sm:flex-1 sm:text-sm   "
                  >
                    <option value="">Seleccionar marca...</option>
                    {brands.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={brandDiscountPct}
                    onChange={(e) => setBrandDiscountPct(e.target.value)}
                    placeholder="%"
                    className="min-h-11 w-20 shrink-0 rounded-md border border-border-strong bg-field px-3 py-1.5 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm   "
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleAddBrandDiscount}
                    className="shrink-0"
                  >
                    Agregar
                  </Button>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  disabled={loading}
                  className="py-2.5 text-sm"
                >
                  {loading ? 'Guardando...' : editingId ? 'Actualizar' : 'Guardar Cliente'}
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

        {/* Listado de Clientes Existentes */}
        <Card className="lg:col-span-2 flex flex-col ">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-action-soft text-action-text rounded-md">
                <Users className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Cartera de Clientes</h2>
                <p className="text-xs text-muted">Total registrados: {total}</p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push('/backoffice/import')}
              className="whitespace-nowrap"
            >
              Importar Clientes por Excel
            </Button>
          </div>

          {/* Buscador de Clientes en Backoffice */}
          <div className="relative mb-4">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted">
              <Search className="w-4 h-4" />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por código, nombre, localidad, provincia..."
              aria-label="Buscar clientes por código, nombre, localidad o provincia"
              className="min-h-11 w-full rounded-md border border-border-strong bg-field py-2 pl-9 pr-12 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm   "
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Limpiar búsqueda de clientes"
                title="Limpiar búsqueda"
                className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-muted transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <div
            className={`flex-1 min-h-[300px] transition-opacity ${isPending ? 'opacity-60' : 'opacity-100'}`}
          >
            {/* Mobile Card View */}
            <div className="block sm:hidden space-y-3">
              {clients.length === 0 ? (
                <div className="py-12 text-center text-muted text-xs">{emptyMessage}</div>
              ) : (
                clients.map((c) => (
                  <div
                    key={`mob-${c._id}`}
                    data-testid="backoffice-client-card"
                    className="p-4 rounded-lg border space-y-3 bg-surface-muted border-border  "
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-mono text-xs font-semibold text-action-text">
                          {c.code}
                        </span>
                        <h4 className="font-semibold text-sm mt-0.5 text-foreground">{c.name}</h4>
                        <p className="text-xs text-subtle mt-1">
                          {c.address || 'Sin dirección'}{' '}
                          {c.localidad
                            ? `(${c.localidad}${c.province ? `, ${c.province}` : ''})`
                            : c.province
                              ? `(${c.province})`
                              : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-xs font-semibold text-foreground">
                          {c.generalDiscount}% desc.
                        </span>
                        {c.brandDiscounts && c.brandDiscounts.length > 0 && (
                          <span className="block text-[10px] text-action-text font-normal">
                            +{c.brandDiscounts.length} marca(s)
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openDiscountEditor(c)}
                        title="Cambiar descuentos"
                        data-testid="client-discounts-button"
                        className="min-w-0"
                      >
                        <Percent className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">Cambiar descuentos</span>
                      </Button>
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="icon"
                          onClick={() => handleEdit(c)}
                          title="Editar"
                          aria-label={`Editar ${c.name}`}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          tone="red"
                          appearance="ghost"
                          size="icon"
                          onClick={() => setPendingDeleteId(c._id)}
                          title="Eliminar"
                          aria-label={`Eliminar ${c.name}`}
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
                    <TableHeaderCell>Código</TableHeaderCell>
                    <TableHeaderCell>Razón Social</TableHeaderCell>
                    <TableHeaderCell>Dirección / Localidad / Provincia</TableHeaderCell>
                    <TableHeaderCell align="right">Desc. General</TableHeaderCell>
                    <TableHeaderCell align="right">Acciones</TableHeaderCell>
                  </TableHeaderRow>
                </TableHead>
                <TableBody>
                  {clients.length === 0 ? (
                    <TableEmptyRow colSpan={5} className="py-12 text-xs">
                      {emptyMessage}
                    </TableEmptyRow>
                  ) : (
                    clients.map((c) => (
                      <TableRow key={c._id} hover>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-action-text">
                          {c.code}
                        </TableCell>
                        <TableCell className="font-medium text-foreground">{c.name}</TableCell>
                        <TableCell className="text-xs text-foreground">
                          {c.address || '-'}{' '}
                          {c.localidad
                            ? `(${c.localidad}${c.province ? `, ${c.province}` : ''})`
                            : c.province
                              ? `(${c.province})`
                              : ''}
                        </TableCell>
                        <TableCell align="right" className="font-semibold text-foreground">
                          {c.generalDiscount}%
                          {c.brandDiscounts && c.brandDiscounts.length > 0 && (
                            <span className="block text-[10px] text-action-text font-normal">
                              +{c.brandDiscounts.length} marca(s) con desc.
                            </span>
                          )}
                        </TableCell>
                        <TableCell align="right" className="whitespace-nowrap space-x-2">
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => openDiscountEditor(c)}
                            title="Cambiar descuentos"
                            aria-label="Cambiar descuentos"
                            data-testid="client-discounts-button"
                          >
                            <Percent className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => handleEdit(c)}
                            title="Editar"
                            aria-label={`Editar ${c.name}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            tone="red"
                            appearance="ghost"
                            size="icon-sm"
                            onClick={() => setPendingDeleteId(c._id)}
                            title="Eliminar"
                            aria-label={`Eliminar ${c.name}`}
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
          </div>

          {/* Paginación */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-xs text-muted">
              <span>
                Página {page} de {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={() => goToPage(page - 1)}
                  disabled={page === 1 || isPending}
                  title="Anterior"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={() => goToPage(page + 1)}
                  disabled={page === totalPages || isPending}
                  title="Siguiente"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={discountEditorClient !== null}
        onClose={closeDiscountEditor}
        labelledBy={quickDiscountTitleId}
        describedBy={quickDiscountDescriptionId}
        variant="responsive"
        initialFocusRef={quickDiscountInputRef}
      >
        <form onSubmit={handleQuickDiscountSubmit} data-testid="quick-client-discounts-modal">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={quickDiscountTitleId} className="text-base font-semibold">
                Cambiar descuentos
              </h2>
              <p id={quickDiscountDescriptionId} className="mt-1 text-sm text-muted">
                {discountEditorClient
                  ? `${discountEditorClient.code} · ${discountEditorClient.name}`
                  : ''}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={closeDiscountEditor}
              title="Cerrar"
              aria-label="Cerrar edición de descuentos"
              disabled={quickDiscountSaving}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label
                htmlFor={quickGeneralDiscountId}
                className="mb-1 block text-xs font-semibold text-foreground"
              >
                Descuento general (%)
              </label>
              <input
                id={quickGeneralDiscountId}
                ref={quickDiscountInputRef}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={0.01}
                value={quickGeneralDiscount}
                onChange={(e) => setQuickGeneralDiscount(e.target.value)}
                required
                className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
              />
            </div>

            <div className="rounded-lg border border-border bg-surface-muted p-4">
              <span className="mb-2 block text-xs font-semibold text-foreground">
                Descuentos por marca
              </span>

              <div className="mb-3 space-y-2">
                {quickBrandDiscounts.map((discount) => {
                  const brand = brands.find((item) => item._id === discount.brandId);

                  return (
                    <div
                      key={discount.brandId}
                      className="flex items-center justify-between rounded-lg border border-border bg-surface p-2 text-xs text-foreground"
                    >
                      <span className="min-w-0 truncate">{brand?.name || 'Marca desconocida'}</span>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="font-semibold text-foreground">
                          {discount.discountPercentage}%
                        </span>
                        <Button
                          type="button"
                          appearance="ghost"
                          tone="red"
                          size="icon-sm"
                          onClick={() => handleRemoveQuickBrandDiscount(discount.brandId)}
                          title="Eliminar descuento de marca"
                          aria-label={`Eliminar descuento de ${brand?.name || 'la marca'}`}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {quickBrandDiscounts.length === 0 && (
                  <p className="text-[11px] italic text-muted">
                    No hay descuentos por marca configurados para este cliente.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <select
                  id={quickBrandSelectId}
                  value={quickSelectedBrandId}
                  onChange={(e) => setQuickSelectedBrandId(e.target.value)}
                  aria-label="Marca para el descuento"
                  className="min-h-11 min-w-0 basis-full rounded-md border border-border-strong bg-field px-3 py-1.5 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30 sm:basis-0 sm:flex-1 sm:text-sm"
                >
                  <option value="">Seleccionar marca...</option>
                  {brands.map((brand) => (
                    <option key={brand._id} value={brand._id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
                <input
                  id={quickBrandPctId}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.01}
                  value={quickBrandDiscountPct}
                  onChange={(e) => setQuickBrandDiscountPct(e.target.value)}
                  placeholder="%"
                  aria-label="Porcentaje de descuento de la marca"
                  className="min-h-11 w-20 shrink-0 rounded-md border border-border-strong bg-field px-3 py-1.5 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30 sm:text-sm"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleAddQuickBrandDiscount}
                  className="shrink-0"
                >
                  Agregar
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={closeDiscountEditor}
              disabled={quickDiscountSaving}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={quickDiscountSaving}
              loadingLabel="Guardando..."
            >
              Guardar descuentos
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Eliminar cliente"
        message="¿Estás seguro de eliminar este cliente? Esta acción no se puede deshacer."
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
