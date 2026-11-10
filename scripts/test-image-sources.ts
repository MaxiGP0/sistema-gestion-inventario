/**
 * Pruebas de la allowlist de imágenes del catálogo:
 * - Las rutas locales y los hosts listados por HTTPS se optimizan.
 * - Los hosts parecidos/maliciosos, HTTP y data URLs no pasan por el optimizador.
 * - next.config.ts declara exactamente los mismos hosts que usa ProductThumbnail.
 *
 * No requiere base de datos ni servidor. Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import nextConfig from '../next.config';
import {
  OPTIMIZABLE_IMAGE_HOSTS,
  isOptimizableImageHostname,
  isOptimizableImageUrl,
} from '../lib/image-sources';

test('optimiza rutas locales y hosts reales permitidos por HTTPS', () => {
  assert.equal(isOptimizableImageUrl('/uploads/producto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://images.unsplash.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://res.cloudinary.com/demo/foto.jpg'), true);
  assert.equal(
    isOptimizableImageUrl('https://proyecto.supabase.co/storage/v1/object/public/foto.png'),
    true,
  );
  assert.equal(isOptimizableImageUrl('https://bucket.s3.amazonaws.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://bucket.s3.us-east-1.amazonaws.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://d1abc.cloudfront.net/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://http2.mlstatic.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://acdn.mitiendanube.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://cdn.vtexassets.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://inventario.example.com/foto.jpg'), true);
});

test('acepta subdominios de un nivel y rechaza hosts parecidos o profundos', () => {
  assert.equal(isOptimizableImageHostname('www.inventario.example.com'), true);
  assert.equal(isOptimizableImageHostname('inventario.example.com'), true);
  assert.equal(isOptimizableImageHostname('a.b.inventario.example.com'), false);
  assert.equal(isOptimizableImageHostname('images.unsplash.com.evil.net'), false);
  assert.equal(isOptimizableImageHostname('evilinventario.example.com'), false);
  assert.equal(isOptimizableImageHostname('sub.proyecto.supabase.co'), false);
});

test('no optimiza hosts fuera de la allowlist ni protocolos inseguros', () => {
  assert.equal(isOptimizableImageUrl(''), false);
  assert.equal(isOptimizableImageUrl('https://evil.example.net/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('https://images.unsplash.com.evil.net/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('http://images.unsplash.com/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('javascript:alert(1)'), false);
  assert.equal(isOptimizableImageUrl('data:image/png;base64,AAAA'), false);
  assert.equal(isOptimizableImageUrl('blob:https://app.local/123'), false);
  assert.equal(isOptimizableImageUrl('//images.unsplash.com/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('/\\evil.example.net/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('foto.jpg'), false);
});

test('la allowlist no incluye el dominio de ejemplo genérico', () => {
  const hosts = OPTIMIZABLE_IMAGE_HOSTS as readonly string[];
  // `inventario.example.com` es el host de demostración reservado del repo;
  // el dominio genérico `example.com` (y su wildcard) nunca debe habilitarse.
  assert.equal(hosts.includes('example.com'), false);
  assert.equal(hosts.includes('*.example.com'), false);
});

test('next.config.ts declara los mismos hosts que la allowlist', () => {
  const patterns = (nextConfig.images?.remotePatterns ?? []) as {
    protocol?: string;
    hostname?: string;
  }[];

  assert.equal(patterns.length, OPTIMIZABLE_IMAGE_HOSTS.length);

  for (const hostname of OPTIMIZABLE_IMAGE_HOSTS) {
    assert.ok(
      patterns.some((pattern) => pattern.protocol === 'https' && pattern.hostname === hostname),
      `Falta el patrón HTTPS para ${hostname}`,
    );
  }
});
