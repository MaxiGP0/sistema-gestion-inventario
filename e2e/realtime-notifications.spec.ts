import { expect, test } from '@playwright/test';
import { E2E_BASE_URL } from './config';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import {
  clientIdByCode,
  createOrder,
  deleteOrderAsAdmin,
  loginAs,
  ordersForClient,
} from './helpers';

interface TrackedSseEvent {
  type?: string;
  targetRole?: string;
}

const CONTEXT_OPTIONS = {
  baseURL: E2E_BASE_URL,
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
  viewport: { width: 1440, height: 900 },
};

test.describe('Campana y SSE', () => {
  test('un alta en otro contexto llega en vivo a la campana de depósito', async ({
    browser,
    request,
  }) => {
    const sellerContext = await browser.newContext(CONTEXT_OPTIONS);
    const depositContext = await browser.newContext(CONTEXT_OPTIONS);
    const seller = await sellerContext.newPage();
    const deposit = await depositContext.newPage();
    let orderId: string | undefined;

    try {
      // Instrumenta EventSource antes de que cargue la app para comprobar que
      // la actualización llegó por SSE y no por el polling de seguridad.
      await deposit.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        const tracked: TrackedSseEvent[] = [];
        (window as unknown as { __sseEvents: TrackedSseEvent[] }).__sseEvents = tracked;

        class TrackingEventSource extends NativeEventSource {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            this.addEventListener('message', (event) => {
              try {
                tracked.push(JSON.parse((event as MessageEvent).data) as TrackedSseEvent);
              } catch {
                // Evento no JSON: no afecta la aserción de notificación.
              }
            });
          }
        }

        window.EventSource = TrackingEventSource;
      });

      await loginAs(seller, E2E_USERS.seller);

      const sseResponse = deposit.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/events' && response.status() === 200,
        { timeout: 30_000 },
      );

      await loginAs(deposit, E2E_USERS.deposit);
      expect((await sseResponse).status()).toBe(200);

      // La bandeja queda abierta antes del alta: si no llegara el SSE, el texto
      // recién aparecería con el polling de seguridad (60 s con SSE sano).
      await deposit.getByRole('button', { name: 'Abrir bandeja de notificaciones' }).click();
      await expect(deposit.getByRole('dialog', { name: 'Notificaciones' })).toBeVisible();

      const clientId = await clientIdByCode(seller, E2E_CLIENTS.realtime.code);
      expect(await ordersForClient(seller, clientId)).toHaveLength(0);

      await createOrder(seller, E2E_CLIENTS.realtime, [
        { code: E2E_PRODUCTS.secondary.code, quantity: 1 },
      ]);

      await expect.poll(async () => (await ordersForClient(seller, clientId)).length).toBe(1);
      [orderId] = (await ordersForClient(seller, clientId)).map((order) => order._id);

      await expect(
        deposit.getByTestId('dashboard-latest-orders-table').getByText(E2E_CLIENTS.realtime.name),
      ).toBeVisible({
        timeout: 15_000,
      });

      const events = await deposit.evaluate(
        () =>
          (
            window as unknown as {
              __sseEvents: TrackedSseEvent[];
            }
          ).__sseEvents,
      );
      expect(
        events.some((event) => event.type === 'notification' && event.targetRole === 'deposit'),
      ).toBe(true);
    } finally {
      if (orderId) await deleteOrderAsAdmin(request, orderId);
      await sellerContext.close();
      await depositContext.close();
    }
  });
});
