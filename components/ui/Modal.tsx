'use client';

import { useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useVisualViewport } from '@/hooks/useVisualViewport';
import { cn } from '@/components/ui/cn';

export type ModalVariant = 'center' | 'sheet-top' | 'sheet-bottom' | 'responsive';
export type ModalSize = 'sm' | 'md' | 'lg';

const SIZE_STYLES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

const VARIANT_STYLES: Record<ModalVariant, { container: string; panel: string }> = {
  center: {
    container: 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4',
    panel:
      'w-full max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-surface p-6 text-foreground shadow-elevation-2 animate-pop-in',
  },
  'sheet-top': {
    container:
      'fixed inset-0 z-50 flex flex-col justify-start bg-black/60 backdrop-blur-sm lg:hidden',
    panel:
      'flex w-full max-h-[85vh] flex-col overflow-hidden rounded-b-xl border-b border-border bg-surface px-6 pb-6 pt-[calc(1.5rem+env(safe-area-inset-top))] text-foreground shadow-elevation-2 animate-sheet-in-top supports-[height:100dvh]:max-h-[85dvh]',
  },
  'sheet-bottom': {
    container:
      'fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm lg:hidden',
    panel:
      'flex w-full max-h-[90vh] flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6 text-foreground shadow-elevation-2 animate-sheet-in-bottom supports-[height:100dvh]:max-h-[90dvh]',
  },
  // Hoja inferior en móvil y modal centrado en escritorio. Se usa cuando el
  // mismo formulario debe funcionar en ambos tamaños (alta rápida de cliente).
  responsive: {
    container:
      'fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4',
    panel:
      'flex w-full max-h-[90vh] flex-col overflow-y-auto rounded-t-xl border-t border-border bg-surface px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6 text-foreground shadow-elevation-2 animate-sheet-in-bottom supports-[height:100dvh]:max-h-[90dvh] sm:max-w-md sm:rounded-lg sm:border sm:p-6',
  },
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id del elemento que titula el diálogo. */
  labelledBy: string;
  /** id del texto que describe el diálogo. */
  describedBy?: string;
  role?: 'dialog' | 'alertdialog';
  /** Centrado, hoja superior, hoja inferior (móvil) o adaptable a ambos. */
  variant?: ModalVariant;
  /** Ancho máximo del panel en variantes centradas. */
  size?: ModalSize;
  /** Foco inicial; por defecto, el primer elemento enfocable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Cerrar al hacer clic en el fondo (default: true). */
  closeOnBackdrop?: boolean;
  children: ReactNode;
  /** Clases extra para el panel. */
  className?: string;
  /** Clases extra para el contenedor/fondo. */
  containerClassName?: string;
}

/**
 * Modal compartido: fondo, bloqueo de foco, cierre con Escape y animación de
 * entrada. Las páginas sólo definen el contenido y el ancho del panel.
 */
export default function Modal({
  open,
  onClose,
  labelledBy,
  describedBy,
  role = 'dialog',
  variant = 'center',
  size = 'md',
  initialFocusRef,
  closeOnBackdrop = true,
  children,
  className,
  containerClassName,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const styles = VARIANT_STYLES[variant];
  const isSheet = variant !== 'center';
  // En las hojas móviles ajustamos el contenedor al área visible real para que
  // el teclado no tape el contenido (iOS no achica `vh`/`dvh` con el teclado).
  const keyboardViewport = useVisualViewport(open && isSheet);
  const viewportHeight = keyboardViewport.height;

  useFocusTrap(panelRef, {
    active: open,
    onEscape: onClose,
    initialFocusRef,
  });

  if (!open) return null;

  const containerStyle: CSSProperties | undefined =
    isSheet && viewportHeight !== null
      ? {
          top: keyboardViewport.offsetTop,
          height: viewportHeight,
          bottom: 'auto',
        }
      : undefined;

  // Deja un pequeño margen sobre el borde del teclado. El `max-h` en dvh de
  // las clases cubre el caso sin `visualViewport`.
  const panelStyle: CSSProperties | undefined =
    isSheet && viewportHeight !== null
      ? {
          maxHeight: Math.round(viewportHeight * (variant === 'sheet-top' ? 0.85 : 0.9)),
        }
      : undefined;

  return (
    <div
      className={cn(styles.container, containerClassName)}
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
      style={containerStyle}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onClick={(event) => event.stopPropagation()}
        style={panelStyle}
        className={cn(
          styles.panel,
          variant === 'center' && SIZE_STYLES[size],
          'focus:outline-none',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
