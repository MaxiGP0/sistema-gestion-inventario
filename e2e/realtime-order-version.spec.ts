import { expect, test, type Page } from '@playwright/test';
import { E2E_BASE_URL } from './config';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { createOrder, deleteOrderAsAdmin, fetchOrder, loginAs } from './helpers';

/**
 * Refresco en vivo del panel y detección temprana de versiones en detalles.
 *
 * El primer caso comprueba que el CustomEvent que republica la campana refresca
 * los contadores del Server Component. El segundo simula un operario de depósito
 * con picking local sin guardar mientras otro usuario avanza la versión remota.
 */

const CONTEXT_OPTIONS = {
  baseURL: E2E_BASE_URL,
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
  viewport: { width: 1440, height: 900 },
};

async function dispatchOrderNotification(
  page: Page,
  orderId: string,
  targetRole: 'deposit' | 'billing',
) {
  await page.evaluate(
    ({ orderId: id, targetRole: role }) => {
      window.dispatchEvent(
        new CustomEvent('sgi:order-notification', {
          detail: { targetRole: role, orderId: id },
        }),
      );
    },
    { orderId, targetRole },
  );
}

test.describe('Actualizaciones en vivo de pedidos', () => {
  test('el panel de depósito refresca sus contadores al recibir la notificación', async ({
    browser,
    request,
  }) => {
    const sellerContext = await browser.newContext(CONTEXT_OPTIONS);
    const depositContext = await browser.newContext(CONTEXT_OPTIONS);
    const seller = await sellerContext.newPage();
    const deposit = await depositContext.newPage();
    let orderId: string | undefined;

    try {
      await loginAs(deposit, E2E_USERS.deposit);
      await loginAs(seller, E2E_USERS.seller);

      const countCard = deposit.getByTestId('dashboard-count-borrador');
      const readDraftCount = async () => {
        const text = await countCard.innerText();
        return Number(text.match(/\d+/)?.[0] ?? 0);
      };

      const before = await readDraftCount();

      // El alta crea una notificación de depósito y la campana republica el
      // evento que escucha DashboardHeaderActions (mismo camino que el SSE).
      orderId = await createOrder(seller, E2E_CLIENTS.realtime, [
        { code: E2E_PRODUCTS.secondary.code, quantity: 1 },
      ]);

      await expect.poll(readDraftCount, { timeout: 20_000 }).toBe(before + 1);
    } finally {
      if (orderId) await deleteOrderAsAdmin(request, orderId);
      await sellerContext.close();
      await depositContext.close();
    }
  });

  test('el detalle de depósito fusiona comentarios y avisa cambios reales con picking local', async ({
    browser,
    request,
  }) => {
    const sellerContext = await browser.newContext(CONTEXT_OPTIONS);
    const depositContext = await browser.newContext(CONTEXT_OPTIONS);
    const seller = await sellerContext.newPage();
    const deposit = await depositContext.newPage();
    let orderId: string | undefined;

    try {
      await loginAs(seller, E2E_USERS.seller);

      orderId = await createOrder(seller, E2E_CLIENTS.realtime, [
        { code: E2E_PRODUCTS.primary.code, quantity: 1 },
      ]);

      await loginAs(deposit, E2E_USERS.deposit);
      await deposit.goto(`/deposit/orders/${orderId}`);
      await expect(
        deposit.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
      ).toBeVisible();

      // Cambio local sin guardar: el próximo refresh no debe pisar este valor.
      const quantityInput = deposit
        .locator('input[aria-label^="Cantidad controlada de"]:visible')
        .first();
      await quantityInput.fill('2');
      await expect(quantityInput).toHaveValue('2');

      // Otro usuario sólo agrega un comentario: la versión/comentarios se
      // fusionan solos y el picking local sigue intacto, sin banner.
      const beforeUpdate = await fetchOrder(seller, orderId);
      const updateResponse = await seller.request.put(`/api/orders/${orderId}`, {
        data: {
          version: beforeUpdate.version,
          comment: 'Actualización externa E2E',
        },
      });
      expect(updateResponse.status()).toBe(200);

      const refreshResponse = deposit.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'GET',
      );

      await dispatchOrderNotification(deposit, orderId, 'deposit');
      expect((await refreshResponse).status()).toBe(200);

      const banner = deposit.getByTestId('order-stale-version-banner');
      await expect(banner).toHaveCount(0);
      await expect(deposit.getByTestId('order-comments-list')).toContainText(
        'Actualización externa E2E',
      );
      await expect(quantityInput).toHaveValue('2');

      // Un cambio real (archivado/estado/líneas) sí exige decisión manual.
      const beforeArchive = await fetchOrder(seller, orderId);
      const archiveResponse = await seller.request.put(`/api/orders/${orderId}`, {
        data: {
          version: beforeArchive.version,
          archived: true,
        },
      });
      expect(archiveResponse.status()).toBe(200);

      const staleRefreshResponse = deposit.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'GET',
      );

      await dispatchOrderNotification(deposit, orderId, 'deposit');
      expect((await staleRefreshResponse).status()).toBe(200);

      await expect(banner).toBeVisible();
      await expect(banner.getByText('Hay una versión más reciente del pedido')).toBeVisible();

      // El botón descarta la pintura local y adopta la versión del servidor.
      await banner.getByRole('button', { name: 'Cargar última versión' }).click();

      await expect(banner).toHaveCount(0);
      await expect(deposit.getByText('Pedido actualizado')).toBeVisible();
      await expect(quantityInput).toHaveValue('1');

      // Sin cambios locales, la siguiente versión remota se aplica sola y el
      // comentario nuevo aparece sin recargar la página.
      const afterApply = await fetchOrder(seller, orderId);
      const secondUpdate = await seller.request.put(`/api/orders/${orderId}`, {
        data: {
          version: afterApply.version,
          comment: 'Segunda actualización externa E2E',
        },
      });
      expect(secondUpdate.status()).toBe(200);

      const autoRefreshResponse = deposit.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'GET',
      );

      await dispatchOrderNotification(deposit, orderId, 'deposit');
      expect((await autoRefreshResponse).status()).toBe(200);

      await expect(deposit.getByTestId('order-comments-list')).toContainText(
        'Segunda actualización externa E2E',
      );
      await expect(banner).toHaveCount(0);
    } finally {
      if (orderId) await deleteOrderAsAdmin(request, orderId);
      await sellerContext.close();
      await depositContext.close();
    }
  });
});
