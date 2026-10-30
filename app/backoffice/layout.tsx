import { requireAdminPage } from '@/lib/auth-page';
import { sectionMetadata } from '@/lib/metadata';
import BackofficeShell from './BackofficeShell';

/**
 * Metadata de la sección Catálogos. El template define el sufijo de las
 * páginas hijas (Marcas, Clientes, Productos) y el default cubre la
 * importación, que es un Client Component y no exporta metadata propia.
 */
export const metadata = sectionMetadata(
  'Catálogos',
  'Administración del catálogo del Sistema de Gestión de Inventario: marcas, clientes, productos e importación masiva desde Excel.',
);

export default async function BackofficeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await requireAdminPage();

  return (
    <BackofficeShell role={session.role} username={session.username}>
      {children}
    </BackofficeShell>
  );
}
