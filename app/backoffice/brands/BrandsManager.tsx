'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Tag, Pencil, Trash2, X } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
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
import { useToast } from '@/context/ToastContext';
import { api } from '@/lib/api-client';
import { invalidateCatalogCache } from '@/lib/catalog-query-cache';
import type { BrandDTO, BrandMutationResponse, DeleteResponse } from '@/lib/types';

interface BrandsManagerProps {
  initialBrands: BrandDTO[];
}

/**
 * Interacciones del backoffice de marcas. Los datos llegan resueltos desde el
 * Server Component; después de cada mutación se invalida la caché en el route
 * handler y `router.refresh()` vuelve a renderizar la lista en el servidor.
 */
export default function BrandsManager({ initialBrands }: BrandsManagerProps) {
  const brands = initialBrands;
  const [name, setName] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const formCardRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const url = editingId ? `/api/brands/${editingId}` : '/api/brands';
      const data = editingId
        ? await api.put<BrandMutationResponse>(url, { name, codePrefix })
        : await api.post<BrandMutationResponse>(url, { name, codePrefix });

      showToast(data.message || 'Marca guardada exitosamente', 'success');
      invalidateCatalogCache('brands', 'products');
      setName('');
      setCodePrefix('');
      setEditingId(null);
      router.refresh();
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (brand: BrandDTO) => {
    setEditingId(brand._id);
    setName(brand.name);
    setCodePrefix(brand.codePrefix || '');

    // En mobile el formulario queda arriba: llevamos al usuario hasta él y
    // dejamos el cursor listo en el nombre de la marca.
    requestAnimationFrame(() => {
      formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      nameInputRef.current?.focus({ preventScroll: true });
    });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setName('');
    setCodePrefix('');
  };

  const handleDelete = async (id: string) => {
    try {
      const data = await api.delete<DeleteResponse>(`/api/brands/${id}`);

      showToast(data.message || 'Marca eliminada exitosamente', 'success');
      invalidateCatalogCache('brands', 'products');
      if (editingId === id) handleCancelEdit();
      router.refresh();
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        {/* Formulario */}
        <div ref={formCardRef} className="scroll-mt-24">
          <Card className={`h-fit transition-shadow ${editingId ? 'ring-2 ring-focus/40' : ''}`}>
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <Tag className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {editingId ? 'Editar Marca' : 'Nueva Marca'}
                </h2>
                <p className="text-xs text-muted">
                  {editingId ? 'Modificar datos de la marca' : 'Registrar nueva marca'}
                </p>
              </div>
            </div>

            {editingId && (
              <div
                role="status"
                aria-live="polite"
                data-testid="brand-editing-indicator"
                className="mb-4 flex items-start gap-2 rounded-md border border-action/30 bg-action-soft px-3 py-2 text-xs text-action-text"
              >
                <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  <span className="font-semibold">Editando</span> {name || 'marca seleccionada'}
                </span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Nombre de la Marca
                </label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Ej: Capitalis, Algabó"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground">
                  Prefijo de Código (Opcional)
                </label>
                <input
                  type="text"
                  value={codePrefix}
                  onChange={(e) => setCodePrefix(e.target.value)}
                  placeholder="Ej: C, B"
                  className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30"
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
                  {loading ? 'Guardando...' : editingId ? 'Actualizar' : 'Crear Marca'}
                </Button>
                {editingId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCancelEdit}
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

        {/* Listado de Marcas */}
        <Card className="flex flex-col lg:col-span-2">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <Tag className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Marcas Registradas</h2>
                <p className="text-xs text-muted">Total: {brands.length} marcas</p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push('/backoffice/products')}
              className="shrink-0 whitespace-nowrap"
            >
              Ir a Productos
            </Button>
          </div>

          <div className="flex-1">
            {/* Mobile Card View */}
            <div className="block space-y-3 sm:hidden">
              {brands.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted">
                  No hay marcas registradas.
                </div>
              ) : (
                brands.map((b) => (
                  <div
                    key={`mob-${b._id}`}
                    data-testid="backoffice-brand-card"
                    className="flex items-center justify-between rounded-lg border border-border bg-surface-muted p-4"
                  >
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{b.name}</h3>
                      <p className="mt-0.5 font-mono text-xs text-action-text">
                        {b.codePrefix ? `Prefijo: ${b.codePrefix}` : 'Sin prefijo'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={() => handleEdit(b)}
                        title="Editar"
                        aria-label={`Editar ${b.name}`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        tone="red"
                        appearance="ghost"
                        size="icon"
                        onClick={() => setPendingDeleteId(b._id)}
                        title="Eliminar"
                        aria-label={`Eliminar ${b.name}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
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
                    <TableHeaderCell>Nombre</TableHeaderCell>
                    <TableHeaderCell>Prefijo de Código</TableHeaderCell>
                    <TableHeaderCell align="right">Acciones</TableHeaderCell>
                  </TableHeaderRow>
                </TableHead>
                <TableBody>
                  {brands.length === 0 ? (
                    <TableEmptyRow colSpan={3}>No hay marcas registradas.</TableEmptyRow>
                  ) : (
                    brands.map((b) => (
                      <TableRow key={b._id} hover>
                        <TableCell className="font-semibold text-foreground">{b.name}</TableCell>
                        <TableCell className="font-mono text-xs text-action-text">
                          {b.codePrefix || <span className="text-muted">Sin prefijo</span>}
                        </TableCell>
                        <TableCell align="right" className="whitespace-nowrap space-x-2">
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => handleEdit(b)}
                            title="Editar"
                            aria-label={`Editar ${b.name}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            tone="red"
                            appearance="ghost"
                            size="icon-sm"
                            onClick={() => setPendingDeleteId(b._id)}
                            title="Eliminar"
                            aria-label={`Eliminar ${b.name}`}
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
        </Card>
      </div>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Eliminar marca"
        message="¿Estás seguro de eliminar esta marca? Esta acción no se puede deshacer."
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
