import { sectionMetadata } from '@/lib/metadata';

/**
 * Metadata de la sección Facturación. El template define el sufijo de la
 * bandeja y de los detalles de pedido.
 */
export const metadata = sectionMetadata(
  'Facturación',
  'Bandeja de facturación: control post-factura y entrega de pedidos.',
);

export default function BillingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
