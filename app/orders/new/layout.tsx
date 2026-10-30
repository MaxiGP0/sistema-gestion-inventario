import { sectionMetadata } from '@/lib/metadata';

/** La metadata del alta vive en el layout; la página es un Server Component. */
export const metadata = sectionMetadata(
  'Nuevo pedido',
  'Alta de pedidos: catálogo por marca, descuentos y borrador offline.',
);

export default function NewOrderLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
