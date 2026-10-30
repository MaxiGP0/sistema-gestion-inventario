import type { Metadata } from 'next';

/** Sufijo común de los títulos de las secciones y páginas de la app. */
export const TITLE_TEMPLATE = '%s · Sistema de Gestión de Inventario';

/**
 * Metadata de una sección: define el título por defecto del segmento y el
 * template que Next aplica a los `title` de las páginas hijas.
 *
 * El template se repite en cada sección (además del layout raíz) porque en
 * esta versión, cuando un layout intermedio exporta un `title` como string,
 * el template del layout raíz deja de aplicarse a las páginas de más abajo.
 */
export function sectionMetadata(title: string, description: string): Metadata {
  return {
    title: {
      default: title,
      template: TITLE_TEMPLATE,
    },
    description,
  };
}
