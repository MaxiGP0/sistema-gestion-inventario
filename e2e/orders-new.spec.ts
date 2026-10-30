import { expect, test } from '@playwright/test';
import { E2E_BRAND, E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { loginAs, panelHeadingFor } from './helpers';

/**
 * El alta de pedidos se renderiza en el servidor: sesión, clientes y marcas
 * viajan en el primer HTML. Al hidratar no se repiten esos GET; el snapshot
 * offline se completa después con el prefetch paginado.
 */
test.describe('Alta de pedidos server-first', () => {
  test('el HTML inicial ya trae clientes, marcas y vendedor sin doble fetch al montar', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.seller);

    const response = await page.request.get('/orders/new');
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain(E2E_USERS.seller.username);
    expect(html).toContain(E2E_CLIENTS.fullFlow.code);
    expect(html).toContain(E2E_CLIENTS.fullFlow.name);
    expect(html).toContain(E2E_BRAND.name);
    expect(html).toContain(E2E_PRODUCTS.primary.name);

    // El refresh de montaje pedía /api/clients?limit=50 y /api/brands, aunque el
    // SSR ya hubiera resuelto ambos. El prefetch posterior usa limit=200 y no
    // debe confundirse con ese doble fetch.
    const mountRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      const limit = url.searchParams.get('limit') ?? '50';

      if (url.pathname === '/api/brands') mountRequests.push('brands');
      if (url.pathname === '/api/clients' && limit === '50') mountRequests.push('clients:50');
    });

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await expect(page.getByPlaceholder('Buscar cliente...')).toBeVisible();

    // Antes del prefetch de 2,5 s no debe repetirse ningún GET del catálogo
    // inicial que ya viajó en el HTML.
    await page.waitForTimeout(1_000);
    expect(mountRequests).toEqual([]);
  });

  test('los roles sin permiso de alta no acceden a /orders/new', async ({ page }) => {
    for (const user of [E2E_USERS.deposit, E2E_USERS.billing]) {
      await loginAs(page, user);

      await page.goto('/orders/new');

      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { name: panelHeadingFor(user) })).toBeVisible();
    }
  });

  test('vendedor y admin sí acceden al alta', async ({ page }) => {
    for (const user of [E2E_USERS.seller, E2E_USERS.admin]) {
      await loginAs(page, user);

      await page.goto('/orders/new');

      await expect(page).toHaveURL(/\/orders\/new$/);
      await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    }
  });
});
