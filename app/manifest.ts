import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sistema de Gestión de Inventario',
    short_name: 'Inventario',
    description: 'Aplicación de gestión de inventario, pedidos, picking y facturación.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // En mobile se prioriza pantalla completa; standalone queda como respaldo
    // para que en desktop se abra como ventana de la app.
    display_override: ['fullscreen', 'standalone', 'minimal-ui'],
    background_color: '#f8fafc',
    theme_color: '#0b0d9f',
    lang: 'es',
    dir: 'ltr',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Nuevo Pedido',
        short_name: 'Nuevo Pedido',
        description: 'Crear un borrador con catálogo y descuentos.',
        url: '/orders/new',
        icons: [
          {
            src: '/icons/shortcut-new-order-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
      {
        name: 'Mis Pedidos',
        short_name: 'Mis Pedidos',
        description: 'Consultar estado, importes y detalle de tus pedidos.',
        url: '/orders',
        icons: [
          {
            src: '/icons/shortcut-orders-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
      {
        name: 'Catálogo',
        short_name: 'Catálogo',
        description: 'Ver productos, marcas y precios vigentes.',
        url: '/catalog',
        icons: [
          {
            src: '/icons/shortcut-catalog-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
    ],
  };
}
