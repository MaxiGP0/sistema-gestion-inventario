import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export type ButtonTone = 'blue' | 'emerald' | 'red' | 'amber' | 'purple' | 'indigo' | 'slate';

export type ButtonAppearance = 'solid' | 'outline' | 'soft' | 'ghost';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

/** Variantes del sistema de diseño (Figma 02). Tienen prioridad sobre tone/appearance. */
export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';

const TONE_STYLES: Record<ButtonTone, Record<ButtonAppearance, string>> = {
  blue: {
    solid:
      'bg-action text-action-fg shadow-elevation-1 hover:bg-action-hover active:bg-action-pressed',
    outline:
      'border border-action/30 bg-action-soft text-action-text hover:bg-action-soft-hover active:bg-action-soft-hover',
    soft: 'bg-action-soft text-action-text hover:bg-action-soft-hover active:bg-action-soft-hover',
    ghost: 'text-action-text hover:bg-action-soft active:bg-action-soft-hover',
  },
  emerald: {
    solid: 'bg-emerald-700 text-white shadow-elevation-1 hover:bg-emerald-600',
    outline:
      'border border-status-delivered-border bg-status-delivered-soft text-status-delivered hover:brightness-95',
    soft: 'bg-status-delivered-soft text-status-delivered hover:brightness-95',
    ghost: 'text-status-delivered hover:bg-status-delivered-soft',
  },
  red: {
    solid: 'bg-red-700 text-white shadow-elevation-1 hover:bg-red-600',
    outline:
      'border border-status-blocked-border bg-status-blocked-soft text-status-blocked hover:brightness-95',
    soft: 'bg-status-blocked-soft text-status-blocked hover:brightness-95',
    ghost: 'text-status-blocked hover:bg-status-blocked-soft',
  },
  amber: {
    solid: 'bg-amber-700 text-white shadow-elevation-1 hover:bg-amber-600',
    outline:
      'border border-status-draft-border bg-status-draft-soft text-status-draft hover:brightness-95',
    soft: 'bg-status-draft-soft text-status-draft hover:brightness-95',
    ghost: 'text-status-draft hover:bg-status-draft-soft',
  },
  purple: {
    solid: 'bg-purple-700 text-white shadow-elevation-1 hover:bg-purple-600',
    outline:
      'border border-status-ready-border bg-status-ready-soft text-status-ready hover:brightness-95',
    soft: 'bg-status-ready-soft text-status-ready hover:brightness-95',
    ghost: 'text-status-ready hover:bg-status-ready-soft',
  },
  indigo: {
    solid:
      'bg-action text-action-fg shadow-elevation-1 hover:bg-action-hover active:bg-action-pressed',
    outline:
      'border border-action/30 bg-action-soft text-action-text hover:bg-action-soft-hover active:bg-action-soft-hover',
    soft: 'bg-action-soft text-action-text hover:bg-action-soft-hover active:bg-action-soft-hover',
    ghost: 'text-action-text hover:bg-action-soft active:bg-action-soft-hover',
  },
  slate: {
    solid: 'bg-slate-700 text-white shadow-elevation-1 hover:bg-slate-600',
    outline: 'border border-border-strong bg-surface text-foreground hover:bg-surface-muted',
    soft: 'bg-disabled text-foreground hover:bg-border',
    ghost: 'text-muted hover:bg-surface-muted hover:text-foreground',
  },
};

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    'bg-action text-action-fg shadow-elevation-1 hover:bg-action-hover active:bg-action-pressed',
  secondary:
    'border border-border-strong bg-surface text-action-text hover:bg-action-soft active:bg-action-soft-hover',
  destructive:
    'border border-status-blocked-border bg-status-blocked-soft text-status-blocked hover:brightness-95',
  ghost: 'text-action-text hover:bg-action-soft active:bg-action-soft-hover',
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'min-h-9 gap-1.5 rounded-md px-3 text-xs max-md:min-h-11 max-md:min-w-11',
  md: 'min-h-10 gap-2 rounded-md px-4 text-sm max-md:min-h-11 max-md:min-w-11',
  lg: 'min-h-11 gap-2 rounded-md px-5 text-sm max-md:min-h-11 max-md:min-w-11',
  icon: 'h-10 w-10 rounded-md p-0 max-md:h-11 max-md:w-11',
  'icon-sm': 'h-9 w-9 rounded-md p-0 max-md:h-11 max-md:w-11',
};

const BASE_STYLES =
  'inline-flex items-center justify-center font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed';

const DISABLED_STYLES =
  'disabled:border-border disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** Color semántico del botón. */
  tone?: ButtonTone;
  /** Relleno, borde, fondo suave o solo texto. */
  appearance?: ButtonAppearance;
  /** Variante del design system; si se define, ignora tone/appearance. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ocupa todo el ancho disponible. */
  fullWidth?: boolean;
  /** Muestra spinner y bloquea el botón. */
  loading?: boolean;
  /** Texto visible durante la carga. Si no se define, conserva el texto hijo. */
  loadingLabel?: ReactNode;
}

/**
 * Botón base de la aplicación. Mantiene la API histórica (`tone` + `appearance`)
 * y agrega las variantes del sistema de diseño (`variant`), estados de carga y
 * tamaños alineados a la retícula de 44 px en mobile.
 */
export default function Button({
  tone = 'blue',
  appearance = 'solid',
  variant,
  size = 'md',
  fullWidth = false,
  loading = false,
  loadingLabel,
  className,
  type = 'button',
  children,
  disabled,
  ...props
}: ButtonProps) {
  const fallbackLoadingLabel = typeof children === 'string' ? children : undefined;
  const visibleLoadingLabel = loadingLabel ?? fallbackLoadingLabel;
  const styles = variant ? VARIANT_STYLES[variant] : TONE_STYLES[tone][appearance];

  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        BASE_STYLES,
        styles,
        DISABLED_STYLES,
        SIZE_STYLES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
          {visibleLoadingLabel ? <span>{visibleLoadingLabel}</span> : null}
        </>
      ) : (
        children
      )}
    </button>
  );
}
