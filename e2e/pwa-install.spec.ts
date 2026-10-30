import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

/**
 * La instalación PWA depende de eventos del navegador que Playwright no
 * dispara por sí solo. Estos tests simulan el modo standalone y el evento
 * `beforeinstallprompt`, y verifican que el panel siga funcionando cuando no
 * hay ninguna intención de instalación disponible.
 */

async function mockStandaloneDisplayMode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList => {
        if (query === '(display-mode: standalone)') {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          };
        }

        return originalMatchMedia(query);
      },
    });
  });
}

test('no muestra el botón de instalación si la app ya está instalada', async ({ page }) => {
  await mockStandaloneDisplayMode(page);
  await loginAs(page, E2E_USERS.seller);

  await expect(page.getByRole('button', { name: 'Instalar app' })).toHaveCount(0);
  await expect(page.getByTestId('install-app-banner')).toHaveCount(0);
});

test('beforeinstallprompt muestra el botón y el click llama a prompt()', async ({ page }) => {
  await loginAs(page, E2E_USERS.seller);

  const installButton = page.getByRole('button', { name: 'Instalar app' });

  // El componente escucha el evento desde un `useEffect`. Si se dispara una
  // sola vez antes de que hidrate, se pierde; reintentar el dispatch hasta que
  // aparezca el botón evita depender del timing de hidratación.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          const scope = window as Window & { __installPromptCalls?: number };
          scope.__installPromptCalls = 0;

          const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
            prompt: () => Promise<void>;
            userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
          };

          event.prompt = () => {
            scope.__installPromptCalls = (scope.__installPromptCalls ?? 0) + 1;
            return Promise.resolve();
          };
          event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

          window.dispatchEvent(event);
        });

        return installButton.count();
      },
      { timeout: 15_000 },
    )
    .toBe(1);

  await expect(installButton).toBeVisible();

  await installButton.click();

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __installPromptCalls?: number }).__installPromptCalls,
      ),
    )
    .toBe(1);

  // Al aceptar, la app se instala y el aviso se oculta.
  await expect(installButton).toHaveCount(0);
});

test('el panel carga sin errores cuando no hay evento de instalación', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await loginAs(page, E2E_USERS.seller);

  await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Instalar app' })).toHaveCount(0);
  await expect(page.getByTestId('install-app-banner')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
