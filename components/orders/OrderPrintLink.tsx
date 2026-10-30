import Link from 'next/link';
import { Printer } from 'lucide-react';
import { cn } from '@/components/ui/cn';

interface OrderPrintLinkProps {
  /** Ruta de la hoja imprimible correspondiente al rol/bandeja. */
  href: string;
  /** En cabeceras angostas muestra sólo el ícono en mobile. */
  hideLabelOnMobile?: boolean;
  className?: string;
}

/**
 * Acceso a la hoja de pedido imprimible / PDF desde el detalle.
 *
 * Es un Link real (no un botón con `window.open`) para que funcione aunque el
 * navegador móvil bloquee ventanas emergentes y para conservar la navegación
 * accesible. La hoja vuelve al detalle indicado por `backHref` en su toolbar.
 */
export default function OrderPrintLink({
  href,
  hideLabelOnMobile = false,
  className,
}: OrderPrintLinkProps) {
  return (
    <Link
      href={href}
      aria-label="Imprimir / PDF del pedido"
      data-testid="order-print-link"
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-xs font-semibold text-action-text transition-colors hover:bg-action-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11 max-md:min-w-11',
        className,
      )}
    >
      <Printer className="h-4 w-4" aria-hidden="true" />
      <span className={hideLabelOnMobile ? 'hidden sm:inline' : undefined}>Imprimir / PDF</span>
    </Link>
  );
}
