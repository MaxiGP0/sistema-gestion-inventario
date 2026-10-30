import { sectionMetadata } from '@/lib/metadata';

/**
 * Metadata de la página de login. La página es un Client Component (usa
 * hooks del formulario), así que la metadata vive en este layout de segmento.
 */
export const metadata = sectionMetadata(
  'Iniciar sesión',
  'Acceso al Sistema de Gestión de Inventario.',
);

export default function LoginLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
