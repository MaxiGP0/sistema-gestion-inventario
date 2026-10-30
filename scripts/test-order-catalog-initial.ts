/**
 * Pruebas de la primera página server-first de `useOrderCatalog`:
 * la vista base ya no arranca vacía, el caché del carrito se hidrata con los
 * productos del HTML y "Cargar más" queda disponible desde el primer render.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildInitialProductCache,
  getInitialHasMoreProducts,
  isBaseCatalogView,
  PRODUCTS_PAGE_SIZE,
} from '../hooks/useOrderCatalog';
import { SELECTED_PRODUCTS_FILTER, type OrderCatalogProduct } from '../lib/order-catalog';

const product = (id: string): OrderCatalogProduct => ({
  _id: id,
  brandId: 'marca-1',
  code: `C-${id}`,
  name: `Producto ${id}`,
  price: 100,
});

test('buildInitialProductCache indexa la primera página por id', () => {
  const cache = buildInitialProductCache([product('a'), product('b')]);

  assert.deepEqual(Object.keys(cache).sort(), ['a', 'b']);
  assert.equal(cache.a?.name, 'Producto a');
  assert.deepEqual(buildInitialProductCache([]), {});
});

test('la vista base sólo aplica a "Todas las marcas" sin búsqueda', () => {
  assert.equal(isBaseCatalogView('ALL', ''), true);
  assert.equal(isBaseCatalogView('ALL', '   '), true);
  assert.equal(isBaseCatalogView('ALL', 'ibuprofeno'), false);
  assert.equal(isBaseCatalogView('marca-1', ''), false);
  assert.equal(isBaseCatalogView(SELECTED_PRODUCTS_FILTER, ''), false);
});

test('getInitialHasMoreProducts habilita la carga incremental según el total', () => {
  assert.equal(getInitialHasMoreProducts(PRODUCTS_PAGE_SIZE), false);
  assert.equal(getInitialHasMoreProducts(PRODUCTS_PAGE_SIZE + 1), true);
  assert.equal(getInitialHasMoreProducts(120, 50), true);
  assert.equal(getInitialHasMoreProducts(10, 50), false);
});
