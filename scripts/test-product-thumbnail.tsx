/**
 * Regresión de ProductThumbnail: un host fuera de la allowlist no debe
 * renderizar un `<img>` (ni descargar el original) en mobile; en su lugar se
 * muestra el placeholder con el badge “Imagen no optimizada”.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ProductThumbnail from '../components/ProductThumbnail';

test('un host desconocido no renderiza <img> y muestra el placeholder', () => {
  const html = renderToStaticMarkup(
    createElement(ProductThumbnail, {
      src: 'https://cdn-desconocido.example.net/producto-original.jpg',
      alt: 'Producto de proveedor',
      size: 48,
    }),
  );

  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /cdn-desconocido\.example\.net/);
  assert.match(html, /Imagen no optimizada/);
  assert.match(html, /role="img"/);
});

test('una ruta local pasa por next/image con sizes, calidad y lazy async', () => {
  const html = renderToStaticMarkup(
    createElement(ProductThumbnail, {
      src: '/uploads/producto.png',
      alt: 'Producto local',
      size: 48,
    }),
  );

  assert.match(html, /<img/i);
  assert.match(html, /sizes="\(max-width: 640px\) 48px, 48px"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /[?&]q=75|q=75/);
  assert.doesNotMatch(html, /Imagen no optimizada/);
});
