import type { HTMLAttributes } from 'react';
import { cn } from '@/components/ui/cn';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export type CardElevation = 'none' | '1' | '2';

const PADDING_STYLES: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
};

const ELEVATION_STYLES: Record<CardElevation, string> = {
  none: '',
  1: 'shadow-elevation-1',
  2: 'shadow-elevation-2',
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Espaciado interno; `md` es el usado por la mayoría de las tarjetas. */
  padding?: CardPadding;
  /** Sombra funcional; por defecto las superficies se separan solo con borde. */
  elevation?: CardElevation;
}

/**
 * Superficie base de la app: borde y fondo semánticos. La sombra es opcional
 * (`elevation`) y se reserva para elementos flotantes o tarjetas destacadas.
 */
export default function Card({
  padding = 'md',
  elevation = 'none',
  className,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface transition-colors',
        PADDING_STYLES[padding],
        ELEVATION_STYLES[elevation],
        className,
      )}
      {...props}
    />
  );
}
