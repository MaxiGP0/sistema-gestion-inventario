import { expect, test } from '@playwright/test';
import { E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

interface CspViolationWindow extends Window {
  __cspViolations: string[];
}

test.describe('Cabeceras de seguridad y CSP', () => {
  test('las respuestas incluyen los headers esperados y la CSP en Report-Only', async ({
    request,
  }) => {
    const response = await request.get('/login');
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['permissions-policy']).toContain('microphone=()');
    expect(headers['permissions-policy']).toContain('geolocation=()');

    const csp = headers['content-security-policy-report-only'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers['content-security-policy']).toBeUndefined();

    // Los E2E corren con `next dev`: HSTS sólo se emite en producción.
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  test('login, SSE, next/image y el script de tema no generan violaciones CSP', async ({
    page,
  }) => {
    // El script inline del layout debe aplicar el tema antes del primer paint.
    await page.addInitScript(() => {
      localStorage.setItem('sgi_theme', 'dark');
      const target = window as unknown as CspViolationWindow;
      target.__cspViolations = [];

      document.addEventListener('securitypolicyviolation', (event) => {
        target.__cspViolations.push(
          `${event.effectiveDirective} bloqueó ${event.blockedURI || '(inline)'}`,
        );
      });
    });

    const sseResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/events',
      { timeout: 30_000 },
    );

    await loginAs(page, E2E_USERS.seller);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const sse = await sseResponse;
    expect(sse.status()).toBe(200);

    // El alta de pedido muestra el thumbnail con next/image (producto del seed).
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await page
      .getByPlaceholder('Buscar producto por nombre o código...')
      .fill(E2E_PRODUCTS.primary.code);

    const thumbnail = page.locator('img[src*="/_next/image"]:visible').first();
    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() =>
        thumbnail.evaluate((image) => {
          const img = image as HTMLImageElement;
          return img.complete && img.naturalWidth > 0;
        }),
      )
      .toBe(true);

    const violations = await page.evaluate(
      () => (window as unknown as CspViolationWindow).__cspViolations,
    );
    expect(violations, `violaciones CSP: ${violations.join(' | ')}`).toEqual([]);
  });
});
