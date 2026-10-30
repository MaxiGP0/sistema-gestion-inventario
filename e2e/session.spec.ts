import { expect, test } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { fillOrderForm, loginAs } from './helpers';

const SESSION_PATH = '/api/auth/session';

/**
 * Sesión de punta a punta:
 * - el layout resuelve la sesión en el servidor (una request menos al montar),
 * - /login redirige si ya hay cookie vigente,
 * - logout limpia la cookie y las rutas privadas vuelven al login,
 * - el borrador se restaura en el primer render, sin esperar al cliente.
 */
test.describe('sesión, login y logout', () => {
  test('el primer render trae el usuario del servidor sin pedir /api/auth/session', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.seller);

    const sessionRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === SESSION_PATH) {
        sessionRequests.push(request.url());
      }
    });

    // Navegación completa: el HTML ya debe incluir al vendedor de la sesión.
    const response = await page.request.get('/orders/new');
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(E2E_USERS.seller.username);

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();

    // El contexto de usuario vino como `initialUser`; no hay fetch de arranque.
    await expect.poll(() => sessionRequests, { timeout: 2_000 }).toEqual([]);
  });

  test('/login redirige al panel cuando la sesión sigue vigente', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    await page.goto('/login');

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();
  });

  test('logout cierra la sesión y las rutas privadas vuelven al login', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();

    const session = await page.request.get(SESSION_PATH);
    expect(session.status()).toBe(401);

    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('el borrador se restaura en el primer render, sin esperar la sesión', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    await fillOrderForm(page, E2E_CLIENTS.fullFlow, [
      { code: E2E_PRODUCTS.primary.code, quantity: 3 },
    ]);

    // El guardado es con debounce de 400 ms: esperar a que el borrador incluya
    // la cantidad, no sólo a que exista la clave.
    await expect
      .poll(() =>
        page.evaluate(() => {
          for (const key of Object.keys(window.localStorage)) {
            if (!key.startsWith('sgi_order_draft:')) continue;

            const raw = window.localStorage.getItem(key);
            if (!raw) continue;

            const draft = JSON.parse(raw) as { quantities?: Record<string, number> };
            if (Object.values(draft.quantities ?? {}).includes(3)) return true;
          }

          return false;
        }),
      )
      .toBe(true);

    // Si el proveedor dependiera de /api/auth/session, el aborto dejaría la
    // sesión vacía y el borrador no se restauraría.
    await page.route(`**${SESSION_PATH}`, (route) => route.abort());

    await page.reload();

    await expect(page.getByText('Borrador de pedido restaurado automáticamente')).toBeVisible();
    await expect(
      page.getByPlaceholder(`${E2E_CLIENTS.fullFlow.code} - ${E2E_CLIENTS.fullFlow.name}`),
    ).toBeVisible();

    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    await productSearch.fill(E2E_PRODUCTS.primary.code);

    const row = page.getByRole('row', { name: new RegExp(E2E_PRODUCTS.primary.code) });
    await expect(row.getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ })).toHaveValue(
      '3',
    );

    await page.unroute(`**${SESSION_PATH}`);

    // No dejar un borrador que otras specs puedan restaurar.
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('sgi_order_draft:')) window.localStorage.removeItem(key);
      }
    });
  });
});
