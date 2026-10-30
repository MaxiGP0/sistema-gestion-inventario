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
import { OPTIMIZABLE_IMAGE_HOSTS, isOptimizableImageUrl } from '../lib/image-sources';

test('optimiza rutas locales y hosts permitidos por HTTPS', () => {
  assert.equal(isOptimizableImageUrl('/uploads/producto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://images.unsplash.com/foto.jpg'), true);
  assert.equal(
    isOptimizableImageUrl('https://proyecto.supabase.co/storage/v1/object/public/foto.png'),
    true,
  );
  assert.equal(isOptimizableImageUrl('https://bucket.s3.amazonaws.com/foto.jpg'), true);
  assert.equal(isOptimizableImageUrl('https://www.inventario.example.com/foto.jpg'), true);
});

test('no optimiza hosts fuera de la allowlist ni protocolos inseguros', () => {
  assert.equal(isOptimizableImageUrl(''), false);
  assert.equal(isOptimizableImageUrl('https://evil.example.net/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('https://images.unsplash.com.evil.net/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('http://images.unsplash.com/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('https://sub.proyecto.supabase.co/foto.jpg'), false);
  assert.equal(isOptimizableImageUrl('data:image/png;base64,AAAA'), false);
  assert.equal(isOptimizableImageUrl('blob:https://app.local/123'), false);
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
