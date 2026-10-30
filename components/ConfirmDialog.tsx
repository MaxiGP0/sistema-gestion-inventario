'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';

type ConfirmVariant = 'danger' | 'primary';

interface VariantStyles {
  icon: string;
}

const VARIANT_STYLES: Record<ConfirmVariant, VariantStyles> = {
  danger: {
    icon: 'bg-status-blocked-soft text-status-blocked',
  },
  primary: {
    icon: 'bg-action-soft text-action-text',
  },
};

interface ConfirmDialogProps {
  /** Controla la visibilidad del diálogo. */
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` (rojo) para acciones destructivas; `primary` (azul) para el resto. */
  variant?: ConfirmVariant;
  /**
   * Acción a ejecutar al confirmar. Puede ser asíncrona: mientras se resuelve
   * el diálogo muestra "Procesando..." y bloquea el cierre. Al terminar
   * (éxito o error) se cierra; el llamador es responsable de notificar errores.
   */
  onConfirm: () => void | Promise<void>;
  /** Se invoca al cancelar, al cerrar con Escape/click afuera o al terminar `onConfirm`. */
  onClose: () => void;
}

/**
 * Modal de confirmación reutilizable que reemplaza a `confirm()` nativo,
 * con el mismo lenguaje visual que el resto de la app (dark mode incluido).
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  variant = 'danger',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const close = () => {
    if (busyRef.current) return;
    onClose();
  };

  // Al cerrarse, reiniciar el estado de "procesando" para el próximo uso.
  useEffect(() => {
    if (!open) {
      busyRef.current = false;
      setBusy(false);
    }
  }, [open]);

  const styles = VARIANT_STYLES[variant];

  const handleConfirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      // El llamador ya notifica el error (por ejemplo con showToast).
      console.error('Error en la acción confirmada:', err);
    } finally {
      busyRef.current = false;
      setBusy(false);
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      labelledBy={titleId}
      describedBy={descriptionId}
      size="sm"
      initialFocusRef={confirmButtonRef}
    >
      <div className="flex items-start gap-4">
        <div className={`shrink-0 rounded-md p-3 ${styles.icon}`}>
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 id={titleId} className="text-base font-semibold">
            {title}
          </h3>
          <p id={descriptionId} className="mt-1 text-sm text-muted">
            {message}
          </p>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={close} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          ref={confirmButtonRef}
          variant={variant === 'danger' ? 'destructive' : 'primary'}
          onClick={handleConfirm}
          loading={busy}
          loadingLabel="Procesando..."
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
