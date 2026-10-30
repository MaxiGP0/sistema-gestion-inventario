/**
 * Tamaños de página compartidos entre el catálogo server-side y los browsers
 * client-side. Vive fuera de `lib/catalog.ts` para que los componentes de
 * cliente puedan importarlo sin arrastrar Mongoose ni dependencias de servidor.
 */
export const PRODUCTS_PAGE_SIZE = 50;
export const CLIENTS_PAGE_SIZE = 25;
