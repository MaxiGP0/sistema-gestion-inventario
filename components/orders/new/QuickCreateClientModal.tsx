'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Sparkles, UserPlus, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { api } from '@/lib/api-client';
import { buildClientCodeSuggestion, looksLikeClientCode } from '@/lib/client-code';
import { parseGeneralDiscount } from '@/lib/order-catalog';
import type { ClientDTO, ClientMutationResponse } from '@/lib/types';

interface QuickCreateClientModalProps {
  open: boolean;
  onClose: () => void;
  /** Texto del buscador de clientes: precarga el nombre o el código. */
  initialSearch: string;
  /** La ficha creada se selecciona en el pedido sin salir del alta. */
  onClientCreated: (client: ClientDTO) => void;
}

const INPUT_CLASS =
  'min-h-11 w-full rounded-md border border-border-strong bg-field px-3 py-2.5 text-base text-foreground placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/30 sm:text-sm';

const LABEL_CLASS = 'mb-1 block text-xs font-semibold text-foreground';

/**
 * Alta rápida de cliente desde `/orders/new`.
 *
 * Se carga con `next/dynamic` recién al abrirse. El formulario pide sólo los
 * datos comerciales necesarios para el pedido y, al guardar, devuelve la ficha
 * al alta para seleccionarla automáticamente.
 */
export default function QuickCreateClientModal({
  open,
  onClose,
  initialSearch,
  onClientCreated,
}: QuickCreateClientModalProps) {
  const titleId = useId();
  const codeId = useId();
  const nameId = useId();
  const addressId = useId();
  const localidadId = useId();
  const provinceId = useId();
  const discountId = useId();
  const codeHintId = useId();

  const initialText = initialSearch.trim();
  const initialIsCode = looksLikeClientCode(initialText);

  const [code, setCode] = useState(initialIsCode ? initialText : '');
  const [name, setName] = useState(initialIsCode ? '' : initialText);
  const [address, setAddress] = useState('');
  const [localidad, setLocalidad] = useState('');
  const [province, setProvince] = useState('');
  const [generalDiscount, setGeneralDiscount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const handleSuggestCode = () => {
    setCode(buildClientCodeSuggestion());
    setError(null);
    codeRef.current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;

    const trimmedCode = code.trim();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setError('Ingresá el nombre o la razón social del cliente.');
      nameRef.current?.focus();
      return;
    }

    if (!trimmedCode) {
      setError('Ingresá un código o usá "Sugerir código".');
      codeRef.current?.focus();
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await api.post<ClientMutationResponse>('/api/clients', {
        code: trimmedCode,
        name: trimmedName,
        address: address.trim(),
        localidad: localidad.trim(),
        province: province.trim(),
        generalDiscount: parseGeneralDiscount(generalDiscount),
      });

      onClientCreated(data.client);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el cliente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      variant="responsive"
      initialFocusRef={nameRef}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={titleId} className="flex items-center gap-2 text-base font-semibold">
            <UserPlus className="h-5 w-5 shrink-0 text-action-text" aria-hidden="true" />
            Nuevo Cliente
          </h3>
          <p className="mt-1 text-xs text-muted">
            Alta rápida: al guardar queda seleccionado en este pedido.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={onClose}
          aria-label="Cerrar alta rápida de cliente"
          className="shrink-0"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-status-blocked-border bg-status-blocked-soft px-3 py-2 text-xs text-status-blocked"
        >
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor={codeId} className={LABEL_CLASS}>
            Código <span className="text-status-blocked">*</span>
          </label>
          <div className="flex items-stretch gap-2">
            <input
              ref={codeRef}
              id={codeId}
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={60}
              autoComplete="off"
              placeholder="Ej: CLI-1042"
              aria-describedby={codeHintId}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleSuggestCode}
              aria-label="Sugerir código"
              className="shrink-0 self-stretch"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span className="max-[380px]:sr-only">Sugerir</span>
            </Button>
          </div>
          <p id={codeHintId} className="mt-1 text-[11px] text-muted">
            Si no lo conocés, el botón genera uno con el prefijo CLI-.
          </p>
        </div>

        <div>
          <label htmlFor={nameId} className={LABEL_CLASS}>
            Nombre / Razón Social <span className="text-status-blocked">*</span>
          </label>
          <input
            ref={nameRef}
            id={nameId}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={160}
            autoComplete="organization"
            placeholder="Ej: Farmacia del Pueblo"
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor={addressId} className={LABEL_CLASS}>
            Dirección
          </label>
          <input
            id={addressId}
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            maxLength={200}
            autoComplete="street-address"
            placeholder="Ej: Av. San Martín 1234"
            className={INPUT_CLASS}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={localidadId} className={LABEL_CLASS}>
              Localidad
            </label>
            <input
              id={localidadId}
              type="text"
              value={localidad}
              onChange={(event) => setLocalidad(event.target.value)}
              maxLength={120}
              autoComplete="address-level2"
              placeholder="Ej: Rosario"
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor={provinceId} className={LABEL_CLASS}>
              Provincia
            </label>
            <input
              id={provinceId}
              type="text"
              value={province}
              onChange={(event) => setProvince(event.target.value)}
              maxLength={120}
              autoComplete="address-level1"
              placeholder="Ej: Santa Fe"
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <div>
          <label htmlFor={discountId} className={LABEL_CLASS}>
            Descuento General (%)
          </label>
          <input
            id={discountId}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.01}
            value={generalDiscount}
            onChange={(event) => setGeneralDiscount(event.target.value)}
            placeholder="0"
            className={INPUT_CLASS}
          />
        </div>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={onClose}
            disabled={loading}
            className="sm:min-w-28"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={loading}
            className="sm:min-w-40"
          >
            {loading ? 'Guardando...' : 'Guardar cliente'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
