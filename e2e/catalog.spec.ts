import { expect, test, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

const VALID_ID = 'a'.repeat(24);

/** Abre el catálogo de productos desde la tarjeta del panel operativo. */
async function openCatalogFromDashboard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Ver Catálogo' }).click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole('heading', { name: 'Catálogo de Productos' })).toBeVisible();
}

/** Abre el catálogo de clientes desde la tarjeta del panel operativo. */
async function openClientsCatalogFromDashboard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Ver Clientes' }).click();
  await expect(page).toHaveURL(/\/catalog\/clients$/);
  await expect(page.getByRole('heading', { name: 'Catálogo de Clientes' })).toBeVisible();
}

/** Las mutaciones del catálogo siguen reservadas al administrador. */
async function expectCatalogMutationsForbidden(page: Page): Promise<void> {
  const productCreate = await page.request.post('/api/products', { data: {} });
  expect(productCreate.status()).toBe(403);

  const productUpdate = await page.request.put(`/api/products/${VALID_ID}`, { data: {} });
  expect(productUpdate.status()).toBe(403);

  const productDelete = await page.request.delete(`/api/products/${VALID_ID}`);
  expect(productDelete.status()).toBe(403);

  const brandCreate = await page.request.post('/api/brands', { data: {} });
  expect(brandCreate.status()).toBe(403);

  const brandUpdate = await page.request.put(`/api/brands/${VALID_ID}`, { data: {} });
  expect(brandUpdate.status()).toBe(403);

  const brandDelete = await page.request.delete(`/api/brands/${VALID_ID}`);
  expect(brandDelete.status()).toBe(403);
}

/**
 * El catálogo de clientes es de consulta: editar y eliminar siguen en el admin.
 * El POST sólo se habilita al vendedor para el alta rápida desde `/orders/new`;
 * con un body vacío la validación responde 400 (antes del 403 de otros roles).
 */
async function expectClientMutationsForbidden(
  page: Page,
  { allowCreate = false }: { allowCreate?: boolean } = {},
): Promise<void> {
  const clientCreate = await page.request.post('/api/clients', { data: {} });
  expect(clientCreate.status()).toBe(allowCreate ? 400 : 403);

  const clientUpdate = await page.request.put(`/api/clients/${VALID_ID}`, { data: {} });
  expect(clientUpdate.status()).toBe(403);

  const clientDelete = await page.request.delete(`/api/clients/${VALID_ID}`);
  expect(clientDelete.status()).toBe(403);
}

test.describe('Catálogo de solo lectura', () => {
  test('vendedor ve el catálogo, busca por código y nombre y no tiene acciones de escritura', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.seller);

    // El panel muestra la tarjeta de consulta y no la administración del backoffice.
    await expect(page.getByRole('link', { name: 'Ver Catálogo' })).toBeVisible();
    await expect(page.getByRole('main').getByText('Catálogos', { exact: true })).toHaveCount(0);

    await openCatalogFromDashboard(page);

    for (const header of ['Código', 'Producto', 'Marca', 'Precio s/IVA', 'Precio c/IVA']) {
      await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
    }

    const catalogTable = page.getByRole('table');
    await expect(catalogTable.getByText(E2E_PRODUCTS.primary.code)).toBeVisible();
    await expect(catalogTable.getByText(E2E_PRODUCTS.primary.name)).toBeVisible();
    await expect(page.getByText('E2E Laboratorio').first()).toBeVisible();

    // No hay alta, edición, baja ni importación.
    for (const action of ['Nuevo Producto', 'Guardar Producto', 'Editar', 'Eliminar']) {
      await expect(page.getByRole('button', { name: action })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /importación/i })).toHaveCount(0);

    // Búsqueda por código.
    const search = page.getByPlaceholder('Buscar por código o nombre...');
    await search.fill(E2E_PRODUCTS.secondary.code);
    await page.waitForURL(
      (url) =>
        url.pathname === '/catalog' &&
        url.searchParams.get('search') === E2E_PRODUCTS.secondary.code,
    );
    await expect(catalogTable.getByText(E2E_PRODUCTS.secondary.name)).toBeVisible();
    await expect(catalogTable.getByText(E2E_PRODUCTS.primary.name)).toHaveCount(0);

    // Búsqueda por nombre.
    await search.fill(E2E_PRODUCTS.primary.name);
    await page.waitForURL(
      (url) =>
        url.pathname === '/catalog' && url.searchParams.get('search') === E2E_PRODUCTS.primary.name,
    );
    await expect(catalogTable.getByText(E2E_PRODUCTS.primary.name)).toBeVisible();
    await expect(catalogTable.getByText(E2E_PRODUCTS.secondary.name)).toHaveCount(0);

    await expectCatalogMutationsForbidden(page);
  });

  test('vendedor ve el catálogo de clientes, busca por código y nombre y no tiene acciones de escritura', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.seller);

    await expect(page.getByRole('link', { name: 'Ver Clientes' })).toBeVisible();
    await expect(page.getByRole('main').getByText('Catálogos', { exact: true })).toHaveCount(0);

    await openClientsCatalogFromDashboard(page);

    for (const header of [
      'Código',
      'Cliente',
      'Dirección',
      'Localidad / Provincia',
      'Desc. General',
      'Desc. por Marca',
    ]) {
      await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
    }

    const clientsTable = page.getByRole('table');
    await expect(clientsTable.getByText(E2E_CLIENTS.fullFlow.code)).toBeVisible();
    await expect(clientsTable.getByText(E2E_CLIENTS.fullFlow.name)).toBeVisible();
    await expect(clientsTable.getByText(E2E_CLIENTS.pending.name)).toBeVisible();

    // No hay alta, edición, baja ni importación.
    for (const action of [
      'Nuevo Cliente',
      'Guardar Cliente',
      'Editar',
      'Eliminar',
      'Importar Clientes por Excel',
    ]) {
      await expect(page.getByRole('button', { name: action })).toHaveCount(0);
    }

    // Búsqueda por código.
    const search = page.getByPlaceholder('Buscar por código, nombre, dirección o localidad...');
    await search.fill(E2E_CLIENTS.pending.code);
    await page.waitForURL(
      (url) =>
        url.pathname === '/catalog/clients' &&
        url.searchParams.get('search') === E2E_CLIENTS.pending.code,
    );
    await expect(clientsTable.getByText(E2E_CLIENTS.pending.name)).toBeVisible();
    await expect(clientsTable.getByText(E2E_CLIENTS.fullFlow.name)).toHaveCount(0);

    // Búsqueda por nombre.
    await search.fill(E2E_CLIENTS.fullFlow.name);
    await page.waitForURL(
      (url) =>
        url.pathname === '/catalog/clients' &&
        url.searchParams.get('search') === E2E_CLIENTS.fullFlow.name,
    );
    await expect(clientsTable.getByText(E2E_CLIENTS.fullFlow.name)).toBeVisible();
    await expect(clientsTable.getByText(E2E_CLIENTS.pending.name)).toHaveCount(0);

    await expectClientMutationsForbidden(page, { allowCreate: true });

    // La gestión de clientes del backoffice sigue reservada al admin.
    await page.goto('/backoffice/clients');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();
  });

  test('controlador accede al catálogo y el backoffice sigue bloqueado', async ({ page }) => {
    await loginAs(page, E2E_USERS.deposit);
    await expect(page.getByRole('link', { name: 'Ver Catálogo' })).toBeVisible();

    await openCatalogFromDashboard(page);
    await expect(page.getByRole('table').getByText(E2E_PRODUCTS.primary.name)).toBeVisible();

    // Pestaña de clientes del catálogo de solo lectura.
    await page
      .getByRole('navigation', { name: 'Secciones del catálogo' })
      .getByRole('link', { name: 'Clientes' })
      .click();
    await expect(page).toHaveURL(/\/catalog\/clients$/);
    await expect(page.getByRole('table').getByText(E2E_CLIENTS.fullFlow.name)).toBeVisible();

    // El CRUD de backoffice no es accesible ni por URL directa.
    await page.goto('/backoffice/products');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Panel de depósito' })).toBeVisible();

    await expectCatalogMutationsForbidden(page);
    await expectClientMutationsForbidden(page);
  });

  test('billing no accede al catálogo de productos ni al de clientes', async ({ page }) => {
    await loginAs(page, E2E_USERS.billing);
    await expect(page.getByRole('link', { name: 'Ver Catálogo' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ver Clientes' })).toHaveCount(0);

    await page.goto('/catalog');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Panel de facturación' })).toBeVisible();

    await page.goto('/catalog/clients');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Panel de facturación' })).toBeVisible();
  });
});
