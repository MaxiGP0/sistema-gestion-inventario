import { expect, test } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import {
  clientIdByCode,
  createOrder,
  fillOrderForm,
  loginAs,
  ordersForClient,
  waitForOfflineSyncReady,
  waitForReactHydration,
} from './helpers';

test.describe('Alta de pedidos offline', () => {
  test('guarda el pedido sin conexión y lo sincroniza una sola vez al volver online', async ({
    page,
    context,
  }) => {
    const client = E2E_CLIENTS.offline;

    await loginAs(page, E2E_USERS.seller);

    // Cliente exclusivo del escenario offline: el seed no le crea pedidos.
    const clientId = await clientIdByCode(page, client.code);
    expect(await ordersForClient(page, clientId)).toHaveLength(0);

    await fillOrderForm(page, client, [{ code: E2E_PRODUCTS.primary.code, quantity: 3 }]);

    const postsWhileOffline: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/orders') {
        postsWhileOffline.push(request.url());
      }
    });

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    await page.getByRole('button', { name: 'Guardar Pedido (Borrador)' }).click();

    // Con navigator.onLine=false ni siquiera se intenta el POST: se encola.
    await expect(page.getByTestId('offline-order-pending')).toBeVisible();
    await expect(page.getByText('Pendiente de sincronizar', { exact: true })).toBeVisible();
    expect(postsWhileOffline).toHaveLength(0);

    // El borrador se limpia para no volver a enviar el mismo pedido al abrir
    // el alta; la cola conserva el body con su clientRequestId.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const keys = Object.keys(localStorage).filter((key) =>
            key.startsWith('sgi_order_draft:'),
          );
          const raw = keys.length > 0 ? localStorage.getItem(keys[0]) : null;
          if (!raw) return true;

          const draft = JSON.parse(raw) as {
            quantities?: Record<string, number>;
            selectedClient?: unknown;
          };
          return Object.keys(draft.quantities ?? {}).length === 0 && !draft.selectedClient;
        }),
      )
      .toBe(true);

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

    // El indicador global drena la cola y el aviso local desaparece.
    await expect(page.getByTestId('offline-order-pending')).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(async () => (await ordersForClient(page, clientId)).length, { timeout: 30_000 })
      .toBe(1);

    const [order] = await ordersForClient(page, clientId);
    expect(order.status).toBe('borrador');

    // Disparar dos veces el mismo evento no duplica: la cola ya está vacía y,
    // aun si quedara una entrada, el servidor deduplica por clientRequestId.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForTimeout(1_000);

    expect(await ordersForClient(page, clientId)).toHaveLength(1);
  });

  test('un 400 conserva el alta en la cola y permite restaurarla en el borrador', async ({
    page,
    context,
  }) => {
    const client = E2E_CLIENTS.offline;

    await loginAs(page, E2E_USERS.seller);
    await fillOrderForm(page, client, [{ code: E2E_PRODUCTS.primary.code, quantity: 3 }]);

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.getByRole('button', { name: 'Guardar Pedido (Borrador)' }).click();
    await expect(page.getByTestId('offline-order-pending')).toBeVisible();

    // El primer reintento online recibe un rechazo permanente del servidor.
    let postAttempts = 0;
    await page.route('**/api/orders', async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/orders') {
        postAttempts += 1;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Datos inválidos: el cliente no existe' }),
        });
        return;
      }
      await route.continue();
    });

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await expect.poll(() => postAttempts, { timeout: 30_000 }).toBeGreaterThan(0);

    // La entrada no desaparece: el indicador queda en error y sigue visible.
    const indicator = page.getByTestId('offline-sync-indicator');
    await expect(indicator).toBeVisible({ timeout: 30_000 });
    await expect(indicator).toContainText(/con error/i);

    // Un nuevo evento online no vuelve a enviar el mismo 4xx.
    const attemptsBefore = postAttempts;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForTimeout(1_000);
    expect(postAttempts).toBe(attemptsBefore);

    await indicator.click();
    const queueDialog = page.getByRole('dialog', { name: 'Cola de sincronización' });
    await expect(queueDialog).toBeVisible();

    const failedItem = page.getByTestId('offline-queue-item').filter({
      hasText: 'Alta de pedido',
    });
    await expect(failedItem).toContainText('Error');
    await expect(failedItem).toContainText('Datos inválidos: el cliente no existe');
    await expect(failedItem).toContainText(client.name);
    await failedItem.getByRole('button', { name: 'Restaurar en borrador' }).click();

    // El borrador recupera cliente y cantidades y la entrada fallida se borra.
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(page.getByPlaceholder(`${client.code} - ${client.name}`)).toBeVisible();
    const productRow = page.getByRole('row', { name: new RegExp(E2E_PRODUCTS.primary.code) });
    await expect(productRow).toBeVisible();
    await expect(
      productRow.getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }),
    ).toHaveValue('3');
    await expect(page.getByTestId('offline-sync-indicator')).toBeHidden();
  });

  test('un 409 de picking queda en la cola y permite abrir el pedido o descartarlo', async ({
    page,
    context,
  }) => {
    const client = E2E_CLIENTS.offline;

    await loginAs(page, E2E_USERS.seller);
    await createOrder(page, client, [{ code: E2E_PRODUCTS.primary.code, quantity: 1 }]);

    const clientId = await clientIdByCode(page, client.code);
    const [order] = await ordersForClient(page, clientId);
    expect(order).toBeTruthy();

    await loginAs(page, E2E_USERS.deposit);
    await page.goto(`/deposit/orders/${order._id}`);
    await expect(
      page.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
    ).toBeVisible();
    // El indicador global se carga en un chunk aparte después de hidratar.
    // Si se corta la red antes, el import falla y la cola no se puede abrir.
    await waitForReactHydration(page, '[data-testid="deposit-action-bar"]');
    await waitForOfflineSyncReady(page);

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.getByRole('button', { name: 'Aprobar y Enviar a Facturación' }).click();

    await expect(page.getByTestId('offline-sync-indicator')).toBeVisible();

    // Al reconectar, otro operario ya modificó el pedido: el PUT vuelve 409.
    await page.route(`**/api/orders/${order._id}`, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error:
              'Conflicto de versión: el pedido fue modificado por otro usuario. Recargá el pedido y volvé a intentarlo.',
            code: 'ORDER_VERSION_CONFLICT',
          }),
        });
        return;
      }
      await route.continue();
    });

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

    const indicator = page.getByTestId('offline-sync-indicator');
    await expect(indicator).toContainText(/con error/i, { timeout: 30_000 });
    await indicator.click();

    const queueDialog = page.getByRole('dialog', { name: 'Cola de sincronización' });
    const failedItem = page.getByTestId('offline-queue-item').filter({
      hasText: 'Picking de pedido',
    });
    await expect(failedItem).toContainText('Error');
    await expect(failedItem).toContainText('Conflicto de versión');
    await expect(failedItem.getByRole('button', { name: 'Abrir pedido actual' })).toBeVisible();
    await expect(failedItem.getByRole('button', { name: 'Descartar' })).toBeVisible();

    await failedItem.getByRole('button', { name: 'Abrir pedido actual' }).click();
    await expect(queueDialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/deposit/orders/${order._id}$`));

    // La entrada sigue disponible hasta que el usuario la descarte.
    await expect(indicator).toBeVisible();
    await indicator.click();
    await expect(queueDialog).toBeVisible();
    await page
      .getByTestId('offline-queue-item')
      .filter({ hasText: 'Picking de pedido' })
      .getByRole('button', { name: 'Descartar' })
      .click();

    const confirm = page.getByRole('dialog', { name: 'Descartar cambio' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Descartar' }).click();

    await expect(confirm).toBeHidden();
    await expect(indicator).toBeHidden();
  });
});
