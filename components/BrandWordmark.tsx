import Image from 'next/image';
import { cn } from '@/components/ui/cn';

/**
 * Logotipo horizontal del Sistema de Gestión de Inventario.
 *
 * `alt=""` porque el nombre accesible lo aporta el contenedor o encabezado.
 */
export default function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Image
        src="/brand/logo.png"
        alt=""
        width={40}
        height={38}
        loading="eager"
        className="h-full w-auto shrink-0 object-contain"
      />
      <span className="flex flex-col text-left leading-none">
        <span className="text-xs font-bold tracking-tight text-foreground">SISTEMA DE GESTIÓN</span>
        <span className="mt-0.5 text-[10px] font-semibold tracking-widest text-muted">
          DE INVENTARIO
        </span>
      </span>
    </span>
  );
}
