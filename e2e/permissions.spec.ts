import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

const VALID_ORDER_ID = 'a'.repeat(24);

test.describe('Permisos de navegación por rol', () => {
  test('el vendedor no entra a depósito, facturación ni backoffice', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    // Los accesos operativos de otros roles ni siquiera se muestran.
    await expect(page.getByRole('link', { name: 'Bandeja de Depósito', exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('link', { name: 'Bandeja de Facturación', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Usuarios', exact: true })).toHaveCount(0);

    // El proxy redirige cualquier intento por URL directa al panel.
    for (const path of [
      '/deposit/orders',
      `/deposit/orders/${VALID_ORDER_ID}`,
      '/billing/orders',
      `/billing/orders/${VALID_ORDER_ID}`,
      '/backoffice',
      '/backoffice/users',
      '/backoffice/import',
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();
    }

    // La API también rechaza las mutaciones reservadas a esos roles.
    const picking = await page.request.put(`/api/orders/${VALID_ORDER_ID}`, {
      data: { items: [{ productId: VALID_ORDER_ID, requestedQuantity: 1 }], version: 0 },
    });
    expect(picking.status()).toBe(403);

    const billing = await page.request.put(`/api/orders/${VALID_ORDER_ID}`, {
      data: { status: 'facturacion', version: 0 },
    });
    expect(billing.status()).toBe(403);

    const postControl = await page.request.patch(`/api/orders/${VALID_ORDER_ID}/post-control`, {
      data: { items: [{ _id: VALID_ORDER_ID, postControl: 'ok' }], version: 0 },
    });
    expect(postControl.status()).toBe(403);
  });
});
