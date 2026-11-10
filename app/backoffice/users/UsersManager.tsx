'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronUp, KeyRound, Power, PowerOff, Trash2, UserPlus, Users } from 'lucide-react';
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
import { USER_ROLE_LABELS, USER_ROLES, type UserRole } from '@/lib/authz';
import type { DeleteResponse, UserDTO, UserMutationResponse } from '@/lib/types';

interface UsersManagerProps {
  initialUsers: UserDTO[];
  currentUserId: string;
}

function formatLastLogin(value: string | null): string {
  if (!value) return 'Nunca';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Nunca';

  return date.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const inputClassName =
  'min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30';

/**
 * Backoffice de usuarios: alta, cambio de rol, reset de contraseña y
 * activación/desactivación. La lista llega del Server Component y se refresca
 * después de cada mutación. Las reglas críticas (último admin, auto-baja) las
 * valida la API, no la UI.
 */
export default function UsersManager({ initialUsers, currentUserId }: UsersManagerProps) {
  const users = initialUsers;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('vendedor');
  const [mobileFormOpen, setMobileFormOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<UserDTO | null>(null);
  const [resetUser, setResetUser] = useState<UserDTO | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const resetTitleId = useId();
  const resetDescriptionId = useId();
  const formPanelId = useId();
  const formCardRef = useRef<HTMLDivElement>(null);
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  const router = useRouter();

  const resetForm = () => {
    setUsername('');
    setPassword('');
    setRole('vendedor');
    setMobileFormOpen(false);
  };

  const openMobileForm = () => {
    setMobileFormOpen(true);
    requestAnimationFrame(() => {
      formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      usernameInputRef.current?.focus({ preventScroll: true });
    });
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);

    try {
      const data = await api.post<UserMutationResponse>('/api/users', {
        username,
        password,
        role,
      });

      showToast(data.message || 'Usuario creado exitosamente', 'success');
      resetForm();
      router.refresh();
    } catch (error: unknown) {
      showToast((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = async (user: UserDTO, nextRole: UserRole) => {
    if (nextRole === user.role) return;

    try {
      const data = await api.patch<UserMutationResponse>('/api/users', {
        id: user.id,
        role: nextRole,
      });
      showToast(data.message || 'Rol actualizado exitosamente', 'success');
      router.refresh();
    } catch (error: unknown) {
      showToast((error as Error).message, 'error');
    }
  };

  const handleToggleActive = async (user: UserDTO) => {
    try {
      const data = await api.patch<UserMutationResponse>('/api/users', {
        id: user.id,
        active: !user.active,
      });
      showToast(data.message || 'Usuario actualizado exitosamente', 'success');
      router.refresh();
    } catch (error: unknown) {
      showToast((error as Error).message, 'error');
    }
  };

  const handleDelete = async (user: UserDTO) => {
    try {
      const data = await api.delete<DeleteResponse>(`/api/users?id=${user.id}`);
      showToast(data.message || 'Usuario eliminado exitosamente', 'success');
      router.refresh();
    } catch (error: unknown) {
      showToast((error as Error).message, 'error');
    }
  };

  const openResetPassword = (user: UserDTO) => {
    setResetUser(user);
    setResetPassword('');
  };

  const closeResetPassword = () => {
    if (resetLoading) return;
    setResetUser(null);
    setResetPassword('');
  };

  const handleResetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetUser) return;

    setResetLoading(true);
    try {
      const data = await api.patch<UserMutationResponse>('/api/users', {
        id: resetUser.id,
        password: resetPassword,
      });
      showToast(data.message || 'Contraseña restablecida exitosamente', 'success');
      setResetUser(null);
      setResetPassword('');
      router.refresh();
    } catch (error: unknown) {
      showToast((error as Error).message, 'error');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        {!mobileFormOpen && (
          <Card
            padding="none"
            className="flex items-center justify-between gap-3 px-3 py-1 lg:hidden"
            data-testid="user-mobile-form-toggle"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="rounded-md bg-action-soft p-2 text-action-text">
                <UserPlus className="h-5 w-5" aria-hidden="true" />
              </div>
              <h2 className="truncate text-sm font-semibold text-foreground">Nuevo Usuario</h2>
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={openMobileForm}
              aria-expanded={false}
              aria-controls={formPanelId}
              className="min-h-11 shrink-0"
            >
              + Nuevo Usuario
            </Button>
          </Card>
        )}

        <div
          id={formPanelId}
          ref={formCardRef}
          className={`scroll-mt-24 ${mobileFormOpen ? 'block' : 'hidden'} lg:block`}
        >
          <Card className="h-fit">
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <UserPlus className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-foreground">Nuevo Usuario</h2>
                <p className="text-xs text-muted">Alta con contraseña inicial</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setMobileFormOpen(false)}
                title="Ocultar formulario"
                aria-label="Ocultar formulario"
                className="ml-auto shrink-0 lg:hidden"
              >
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium uppercase mb-1 text-foreground">
                  Usuario
                </label>
                <input
                  ref={usernameInputRef}
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  maxLength={60}
                  autoComplete="off"
                  placeholder="Ej: juan.perez"
                  className={inputClassName}
                />
              </div>

              <div>
                <label className="block text-xs font-medium uppercase mb-1 text-foreground">
                  Contraseña inicial
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  placeholder="Mínimo 6 caracteres"
                  className={inputClassName}
                />
              </div>

              <div>
                <label className="block text-xs font-medium uppercase mb-1 text-foreground">
                  Rol
                </label>
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value as UserRole)}
                  className={inputClassName}
                >
                  {USER_ROLES.map((roleOption) => (
                    <option key={roleOption} value={roleOption}>
                      {USER_ROLE_LABELS[roleOption]}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                type="submit"
                variant="primary"
                fullWidth
                disabled={loading}
                className="py-2.5 text-sm"
              >
                {loading ? 'Creando...' : 'Crear Usuario'}
              </Button>
            </form>
          </Card>
        </div>

        <Card className="lg:col-span-2 ">
          <div className="flex items-center justify-between mb-6 gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-action-soft p-3 text-action-text">
                <Users className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Usuarios Registrados</h2>
                <p className="text-xs text-muted">Total: {users.length} usuarios</p>
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

          {/* En mobile cada usuario se administra como tarjeta táctil. */}
          <div data-testid="backoffice-user-cards" className="block space-y-3 sm:hidden">
            {users.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted">
                No hay usuarios registrados.
              </div>
            ) : (
              users.map((user) => {
                const isSelf = user.id === currentUserId;

                return (
                  <div
                    key={`mob-${user.id}`}
                    className="space-y-3 rounded-lg border border-border bg-surface-muted p-4  "
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-foreground">
                          {user.username}
                          {isSelf && (
                            <span className="ml-2 text-[10px] uppercase text-action-text">Vos</span>
                          )}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          Último acceso: {formatLastLogin(user.lastLoginAt)}
                        </p>
                      </div>
                      <span
                        className={
                          user.active
                            ? 'inline-flex shrink-0 rounded-full bg-status-delivered-soft px-2 py-1 text-xs font-medium text-status-delivered'
                            : 'inline-flex shrink-0 rounded-full bg-surface-muted px-2 py-1 text-xs font-medium text-muted'
                        }
                      >
                        {user.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-medium uppercase text-muted">
                        Rol
                      </label>
                      <select
                        value={user.role}
                        onChange={(event) =>
                          void handleRoleChange(user, event.target.value as UserRole)
                        }
                        aria-label={`Rol de ${user.username}`}
                        className="min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2 text-base text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
                      >
                        {USER_ROLES.map((roleOption) => (
                          <option key={roleOption} value={roleOption}>
                            {USER_ROLE_LABELS[roleOption]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-2 border-t border-border pt-3 ">
                      <span className="text-[11px] text-muted">Acciones</span>
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="icon"
                          onClick={() => openResetPassword(user)}
                          title="Resetear contraseña"
                          aria-label={`Resetear contraseña de ${user.username}`}
                        >
                          <KeyRound className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="secondary"
                          size="icon"
                          onClick={() => void handleToggleActive(user)}
                          disabled={isSelf && user.active}
                          title={user.active ? 'Desactivar' : 'Activar'}
                          aria-label={`${user.active ? 'Desactivar' : 'Activar'} ${user.username}`}
                        >
                          {user.active ? (
                            <PowerOff className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <Power className="h-4 w-4" aria-hidden="true" />
                          )}
                        </Button>
                        <Button
                          tone="red"
                          appearance="ghost"
                          size="icon"
                          onClick={() => setPendingDelete(user)}
                          disabled={isSelf}
                          title="Eliminar"
                          aria-label={`Eliminar ${user.username}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="hidden sm:block">
            <Table dense>
              <TableHead>
                <TableHeaderRow>
                  <TableHeaderCell>Usuario</TableHeaderCell>
                  <TableHeaderCell>Rol</TableHeaderCell>
                  <TableHeaderCell>Estado</TableHeaderCell>
                  <TableHeaderCell>Último acceso</TableHeaderCell>
                  <TableHeaderCell align="right">Acciones</TableHeaderCell>
                </TableHeaderRow>
              </TableHead>
              <TableBody>
                {users.length === 0 ? (
                  <TableEmptyRow colSpan={5}>No hay usuarios registrados.</TableEmptyRow>
                ) : (
                  users.map((user) => {
                    const isSelf = user.id === currentUserId;

                    return (
                      <TableRow key={user.id} hover>
                        <TableCell className="font-semibold text-foreground">
                          {user.username}
                          {isSelf && (
                            <span className="ml-2 text-[10px] uppercase text-action-text">Vos</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <select
                            value={user.role}
                            onChange={(event) =>
                              void handleRoleChange(user, event.target.value as UserRole)
                            }
                            aria-label={`Rol de ${user.username}`}
                            className="rounded-md border border-border-strong bg-field px-2 py-1 text-xs text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
                          >
                            {USER_ROLES.map((roleOption) => (
                              <option key={roleOption} value={roleOption}>
                                {USER_ROLE_LABELS[roleOption]}
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              user.active
                                ? 'inline-flex rounded-full bg-status-delivered-soft px-2 py-0.5 text-xs font-medium text-status-delivered'
                                : 'inline-flex rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted'
                            }
                          >
                            {user.active ? 'Activo' : 'Inactivo'}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted">
                          {formatLastLogin(user.lastLoginAt)}
                        </TableCell>
                        <TableCell align="right" className="space-x-2 whitespace-nowrap">
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => openResetPassword(user)}
                            title="Resetear contraseña"
                            aria-label={`Resetear contraseña de ${user.username}`}
                          >
                            <KeyRound className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => void handleToggleActive(user)}
                            disabled={isSelf && user.active}
                            title={user.active ? 'Desactivar' : 'Activar'}
                            aria-label={`${user.active ? 'Desactivar' : 'Activar'} ${user.username}`}
                          >
                            {user.active ? (
                              <PowerOff className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Power className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>
                          <Button
                            tone="red"
                            appearance="ghost"
                            size="icon-sm"
                            onClick={() => setPendingDelete(user)}
                            disabled={isSelf}
                            title="Eliminar"
                            aria-label={`Eliminar ${user.username}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Eliminar usuario"
        message={`¿Eliminás a "${pendingDelete?.username ?? ''}"? Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        variant="danger"
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await handleDelete(pendingDelete);
        }}
      />

      <Modal
        open={resetUser !== null}
        onClose={closeResetPassword}
        labelledBy={resetTitleId}
        describedBy={resetDescriptionId}
        size="sm"
      >
        <h2 id={resetTitleId} className="text-base font-semibold">
          Resetear contraseña
        </h2>
        <p id={resetDescriptionId} className="mt-1 text-sm text-muted">
          Se cerrarán las sesiones activas de &quot;{resetUser?.username ?? ''}&quot; y deberá
          ingresar con la nueva contraseña.
        </p>

        <form onSubmit={handleResetPassword} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase mb-1 text-foreground">
              Nueva contraseña
            </label>
            <input
              type="password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              placeholder="Mínimo 6 caracteres"
              className={inputClassName}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeResetPassword} disabled={resetLoading}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={resetLoading}>
              {resetLoading ? 'Guardando...' : 'Resetear contraseña'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
