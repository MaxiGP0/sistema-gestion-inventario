import Image from 'next/image';
import { cn } from '@/components/ui/cn';

/**
 * Isotipo del Sistema de Gestión de Inventario. Es decorativo: el nombre del
 * sistema siempre aparece escrito al lado, así que `alt=""` evita que los
 * lectores de pantalla lo dupliquen.
 */
export default function BrandLogo({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/logo.png"
      alt=""
      width={256}
      height={256}
      loading="eager"
      className={cn('object-contain', className)}
    />
  );
}
