import { sectionMetadata } from '@/lib/metadata';

/**
 * Metadata de la sección Depósito. El template define el sufijo de la
 * bandeja y de los detalles de pedido.
 */
export const metadata = sectionMetadata(
  'Depósito',
  'Bandeja de depósito: verificación y picking de pedidos.',
);

export default function DepositLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
