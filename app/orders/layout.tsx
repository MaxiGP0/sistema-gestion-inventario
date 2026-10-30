import { sectionMetadata } from '@/lib/metadata';

/**
 * Metadata de la sección Pedidos. La bandeja "Mis pedidos" y el detalle son
 * las vistas por defecto del segmento; el alta conserva su título en
 * app/orders/new/layout.tsx.
 */
export const metadata = sectionMetadata(
  'Mis pedidos',
  'Historial de pedidos del vendedor: estados, archivados y detalle de solo lectura.',
);

export default function OrdersLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
