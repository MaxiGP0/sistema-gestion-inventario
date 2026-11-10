import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E_BASE_URL } from './config';
import { E2E_PASSWORD, E2E_USERS, type E2EUser } from './fixtures';
import { loginAs, type LoginUser } from './helpers';

/**
 * Revocación de sesión y rol más allá de las escrituras:
 * - una baja/cambio de rol invalida la cookie en la próxima recarga de una
 *   página del backoffice (guarda server-side, no solo proxy);
 * - el cambio de rol corta la conexión SSE de la bandeja anterior y el cliente
 *   vuelve al login;
 * - al reingresar, la bandeja y el alcance de pedidos corresponden al rol nuevo.
 *
 * Los usuarios creados/alterados se restauran o eliminan al final para no
 * contaminar el resto de la suite (workers=1, sin paralelismo entre archivos).
 */

const CONTEXT_OPTIONS = {
  baseURL: E2E_BASE_URL,
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
  viewport: { width: 1440, height: 900 },
};

interface UserListPayload {
  users: Array<{ id: string; username: string; role: E2EUser['role']; active: boolean }>;
}

interface OrderListPayload {
  orders: Array<{ _id: string }>;
}

async function findUserId(request: APIRequestContext, username: string): Promise<string> {
  const response = await request.get('/api/users');
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as UserListPayload;
  const user = payload.users.find((item) => item.username === username);
  expect(user, `el usuario ${username} debe existir en el seed`).toBeTruthy();

  return user!.id;
}

async function patchUser(
  request: APIRequestContext,
  id: string,
  data: { role?: E2EUser['role']; active?: boolean },
): Promise<void> {
  const response = await request.patch('/api/users', { data: { id, ...data } });
  expect(response.status()).toBe(200);
}

async function listOrderIds(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/orders?archived=all&pagination=cursor&limit=100');
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as OrderListPayload;
  return payload.orders.map((order) => order._id);
}

async function createAdminContext(browser: Browser) {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();
  await loginAs(page, E2E_USERS.admin);

  return { context, page };
}

test.describe('revocación de sesión y rol', () => {
  test('una baja o un cambio de rol bloquea /backoffice en la próxima recarga', async ({
    browser,
  }) => {
    const admin = await createAdminContext(browser);
    const targetContext = await browser.newContext(CONTEXT_OPTIONS);
    const target = await targetContext.newPage();
    const username = `e2e-revocacion-${Date.now()}`;
    let targetId: string | undefined;

    try {
      const created = await admin.page.request.post('/api/users', {
        data: { username, password: E2E_PASSWORD, role: 'admin' },
      });
      expect(created.status()).toBe(200);
      targetId = ((await created.json()) as { user: { id: string } }).user.id;

      const tempAdmin: LoginUser = { username, password: E2E_PASSWORD, role: 'admin' };
      await loginAs(target, tempAdmin);

      await target.goto('/backoffice/users');
      await expect(target.getByRole('heading', { name: 'Usuarios', exact: true })).toBeVisible();

      // Cambio de rol desde la API del admin original.
      await patchUser(admin.page.request, targetId, { role: 'vendedor' });

      // La cookie vieja queda con sessionVersion anterior: la página revalida
      // contra Mongo y manda al login, sin esperar las 8 h.
      await target.reload();
      await expect(target).toHaveURL(/\/login$/);
      await expect(target.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();

      // Al reingresar ya tiene el rol nuevo y el proxy lo saca del backoffice.
      const demoted: LoginUser = { username, password: E2E_PASSWORD, role: 'vendedor' };
      await loginAs(target, demoted);
      await target.goto('/backoffice/users');
      await expect(target).toHaveURL(/\/$/);
      await expect(target.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();

      // Una baja también invalida la sesión de la página en la próxima carga.
      await patchUser(admin.page.request, targetId, { active: false });
      await target.goto('/orders');
      await expect(target).toHaveURL(/\/login$/);
    } finally {
      if (targetId) {
        await admin.page.request.delete(`/api/users?id=${targetId}`);
      }
      await targetContext.close();
      await admin.context.close();
    }
  });

  test('el cambio de rol corta el SSE y cambia bandeja y alcance de pedidos', async ({
    browser,
  }) => {
    const admin = await createAdminContext(browser);
    const sellerContext = await browser.newContext(CONTEXT_OPTIONS);
    const seller = await sellerContext.newPage();
    let sellerId: string | undefined;

    try {
      await loginAs(seller, E2E_USERS.seller);
      sellerId = await findUserId(admin.page.request, E2E_USERS.seller.username);

      // Pedido determinista del seed creado por el admin: el vendedor no lo ve.
      const adminOrders = await listOrderIds(admin.page);
      const sellerOrders = await listOrderIds(seller);
      const adminOnlyOrder = adminOrders.find((id) => !sellerOrders.includes(id));
      expect(
        adminOnlyOrder,
        'el seed debe tener un pedido del admin fuera del alcance del vendedor',
      ).toBeTruthy();

      const inboxBefore = await seller.request.get('/api/users/notifications');
      expect(inboxBefore.status()).toBe(200);
      expect(((await inboxBefore.json()) as { inbox: string }).inbox).toBe('vendor');

      // Instrumenta todos los EventSource de la pestaña y abre uno propio para
      // no depender de que la campana esté habilitada. El flag sobrevive a la
      // navegación al login porque vive en sessionStorage (mismo origen).
      await seller.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        class TrackingEventSource extends NativeEventSource {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            this.addEventListener('open', () => {
              try {
                sessionStorage.setItem('e2e:sse-open', '1');
              } catch {
                // sessionStorage bloqueado: el test lo detecta por timeout.
              }
            });
            this.addEventListener('session-expired', () => {
              try {
                sessionStorage.setItem('e2e:session-expired', '1');
              } catch {
                // Idem.
              }
            });
          }
        }

        window.EventSource = TrackingEventSource;
      });
      await seller.reload();
      await seller.evaluate(() => {
        sessionStorage.removeItem('e2e:sse-open');
        sessionStorage.removeItem('e2e:session-expired');
        new EventSource('/api/events');
      });
      await seller.waitForFunction(() => sessionStorage.getItem('e2e:sse-open') === '1', null, {
        timeout: 15_000,
      });

      // Al cambiar el rol, el heartbeat detecta la versión nueva y emite
      // session-expired; si la campana está activa, además navega al login.
      await patchUser(admin.page.request, sellerId, { role: 'billing' });

      await seller.waitForFunction(
        () => sessionStorage.getItem('e2e:session-expired') === '1',
        null,
        { timeout: 45_000 },
      );

      // Si la campana no navegó sola, la próxima carga de la página revalida
      // la sesión y también termina en /login.
      if (!/\/login$/.test(seller.url())) {
        await seller.reload();
      }
      await expect(seller).toHaveURL(/\/login$/);
      await expect(seller.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();

      // Reingreso con el rol actualizado: bandeja de facturación y alcance total.
      const billing: LoginUser = {
        username: E2E_USERS.seller.username,
        password: E2E_USERS.seller.password,
        role: 'billing',
      };
      await loginAs(seller, billing);
      await expect(seller.getByRole('heading', { name: 'Panel de facturación' })).toBeVisible();

      const inboxAfter = await seller.request.get('/api/users/notifications');
      expect(inboxAfter.status()).toBe(200);
      expect(((await inboxAfter.json()) as { inbox: string }).inbox).toBe('billing');

      const billingOrders = await listOrderIds(seller);
      expect(billingOrders).toContain(adminOnlyOrder);

      // /orders ya no es accesible: el proxy usa el rol de la cookie renovada.
      await seller.goto('/orders');
      await expect(seller).toHaveURL(/\/$/);
      await expect(seller.getByRole('heading', { name: 'Panel de facturación' })).toBeVisible();
    } finally {
      if (sellerId) {
        await patchUser(admin.page.request, sellerId, { role: 'vendedor' });
      }
      await sellerContext.close();
      await admin.context.close();
    }
  });
});
