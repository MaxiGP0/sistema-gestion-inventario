import { expect, test, type Page } from '@playwright/test';
import { CHANGE_PASSWORD_SUCCESS_MESSAGE } from '../lib/change-password-form';
import {
  E2E_BRAND,
  E2E_CHANGED_PASSWORD,
  E2E_CLIENTS,
  E2E_PRODUCTS,
  E2E_SECONDARY_BRAND,
  E2E_USERS,
} from './fixtures';
import { clientIdByCode, deleteOrderAsAdmin, waitForReactHydration } from './helpers';

/**
 * Suite transversal de ergonomía móvil. Corre con los perfiles Pixel 7
 * (Chromium) e iPhone 13 (WebKit) definidos en playwright.config.ts.
 *
 * Además del recorrido funcional, falla si:
 * - el documento genera scroll horizontal,
 * - un campo editable queda por debajo de 16 px (zoom automático de iOS),
 * - un botón visible mide menos de 44x44 px.
 */

const MOBILE_WIDTHS = [360, 390, 414, 430] as const;

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;

    // Diagnóstico acotado: los contenedores con overflow-x-auto pueden
    // recortar tablas, por eso sólo se reportan los primeros candidatos.
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();

        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      })
      .slice(0, 5)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className?.toString().slice(0, 120) ?? '',
        right: Math.round(element.getBoundingClientRect().right),
      }));

    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders,
    };
  });

  expect(
    metrics.documentScrollWidth,
    `${label}: document.scrollWidth (${metrics.documentScrollWidth}) > innerWidth (${metrics.viewportWidth}). Candidatos: ${JSON.stringify(metrics.offenders)}`,
  ).toBeLessThanOrEqual(metrics.viewportWidth);

  expect(
    metrics.bodyScrollWidth,
    `${label}: body.scrollWidth (${metrics.bodyScrollWidth}) > innerWidth (${metrics.viewportWidth}). Candidatos: ${JSON.stringify(metrics.offenders)}`,
  ).toBeLessThanOrEqual(metrics.viewportWidth);
}

async function expectEditableFieldsAtLeast16px(page: Page, label: string): Promise<void> {
  const tooSmall = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'));

    const isEditable = (field: HTMLElement): boolean => {
      if (field instanceof HTMLInputElement) {
        if (
          [
            'hidden',
            'checkbox',
            'radio',
            'range',
            'file',
            'color',
            'button',
            'submit',
            'reset',
          ].includes(field.type)
        ) {
          return false;
        }

        return !field.readOnly && !field.disabled;
      }

      if (field instanceof HTMLTextAreaElement) return !field.readOnly && !field.disabled;
      if (field instanceof HTMLSelectElement) return !field.disabled;

      return false;
    };

    return fields
      .filter(isEditable)
      .filter((field) => {
        const rect = field.getBoundingClientRect();
        const style = window.getComputedStyle(field);

        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      })
      .map((field) => {
        const rect = field.getBoundingClientRect();

        return {
          tag: field.tagName.toLowerCase(),
          name:
            field.getAttribute('aria-label') ??
            field.getAttribute('placeholder') ??
            field.getAttribute('name') ??
            '',
          fontSize: Number.parseFloat(window.getComputedStyle(field).fontSize),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((field) => field.fontSize < 16);
  });

  expect(
    tooSmall,
    `${label}: hay campos editables con font-size < 16px (iOS haría zoom al enfocar).`,
  ).toEqual([]);
}

async function expectTouchTargetsAtLeast44px(page: Page, label: string): Promise<void> {
  const tooSmall = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]'),
    );

    return candidates
      .filter((element) => {
        if (element.closest('[aria-hidden="true"], [inert]')) return false;

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.getAttribute('aria-label') ?? element.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);

        return {
          element: element.tagName.toLowerCase(),
          text: text || element.title || '(sin nombre)',
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      })
      .filter((target) => target.width < 44 || target.height < 44);
  });

  expect(tooSmall, `${label}: hay controles táctiles visibles menores a 44x44 px.`).toEqual([]);
}

async function expectMobileErgonomics(page: Page, label: string): Promise<void> {
  await expectNoHorizontalOverflow(page, label);
  await expectEditableFieldsAtLeast16px(page, label);
  await expectTouchTargetsAtLeast44px(page, label);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Área de intersección entre dos cajas; 0 cuando no se superponen. */
function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

  return width > 0 && height > 0 ? width * height : 0;
}

/** Etiqueta accesible del botón que recibe el toque en el centro de la caja. */
async function buttonLabelAtCenter(page: Page, box: Box): Promise<string | null> {
  return page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

/**
 * Login por UI. Espera a que termine la hidratación antes de escribir: en
 * WebKit un `fill` demasiado temprano puede ser pisado por el primer render
 * controlado de React y dejar el usuario vacío.
 */
async function loginThroughUi(
  page: Page,
  user: { username: string; password: string } = E2E_USERS.seller,
): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  const username = page.getByPlaceholder('Ingrese su usuario');
  const password = page.locator('input[type="password"]');

  // WebKit puede pisar el primer fill si React termina de hidratar justo
  // después. Se espera el handler de React y se reintenta por si un remount
  // de desarrollo vuelve a montar el formulario.
  await waitForReactHydration(page, '#login-username');

  await expect(async () => {
    await username.fill(user.username);
    await password.fill(user.password);
    await expect(username).toHaveValue(user.username);
    await expect(password).toHaveValue(user.password);
  }).toPass({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Ingresar al Sistema' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('Ergonomía móvil', () => {
  test('login → panel → alta → bandeja', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();
    await expectMobileErgonomics(page, 'login');

    await loginThroughUi(page);
    await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();

    // En mobile los últimos pedidos se leen como tarjetas, no como tabla.
    await expect(page.getByTestId('dashboard-latest-orders-cards')).toBeVisible();
    await expect(page.getByTestId('dashboard-latest-orders-table')).toBeHidden();
    await expectMobileErgonomics(page, 'panel');

    await page.getByRole('link', { name: 'Nuevo Pedido', exact: true }).click();
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver', exact: true })).toBeVisible();
    await expect(page.getByTestId('mobile-order-action-bar')).toBeVisible();
    await expectMobileErgonomics(page, 'alta');

    // La búsqueda de productos queda accesible y las tarjetas usan controles
    // táctiles de 44 px sin agrandar los íconos.
    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    await productSearch.fill(E2E_PRODUCTS.primary.code);
    await expect(
      page.getByRole('heading', { name: E2E_PRODUCTS.primary.name, exact: true }),
    ).toBeVisible();
    await expectMobileErgonomics(page, 'alta con resultados');

    // "Volver" tiene destino explícito: la bandeja, no el panel ni el alta.
    await page.getByRole('button', { name: 'Volver', exact: true }).click();
    await expect(page).toHaveURL(/\/orders$/);

    await page.getByTestId('mobile-nav-orders').click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();
    await expectMobileErgonomics(page, 'bandeja');
  });
});

test.describe('Navegación móvil continua @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('barra inferior, atajos y CTA de nuevo pedido en la bandeja', async ({ page }) => {
    await loginThroughUi(page, E2E_USERS.seller);

    const nav = page.getByTestId('mobile-bottom-nav');
    await expect(nav).toBeVisible();
    await expect(nav.getByTestId('mobile-nav-panel')).toHaveAttribute('aria-current', 'page');

    for (const item of ['panel', 'new', 'orders', 'catalog', 'account']) {
      await expect(nav.getByTestId(`mobile-nav-${item}`)).toBeVisible();
    }
    for (const item of ['deposit', 'billing']) {
      await expect(nav.getByTestId(`mobile-nav-${item}`)).toHaveCount(0);
    }

    // Cada ítem conserva un área táctil cómoda y la barra queda sobre el
    // contenido, no encima de la barra de acciones del alta.
    const ordersBox = await nav.getByTestId('mobile-nav-orders').boundingBox();
    expect(ordersBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(ordersBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    await nav.getByTestId('mobile-nav-new').click();
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(nav).toBeHidden();
    await expect(page.getByTestId('mobile-order-action-bar')).toBeVisible();

    // La bandeja ofrece el alta en la cabecera, además del atajo inferior.
    await page.goto('/orders');
    await expect(nav).toBeVisible();
    await expect(nav.getByTestId('mobile-nav-orders')).toHaveAttribute('aria-current', 'page');

    const newOrderCta = page.getByTestId('orders-tray-new-order');
    await expect(newOrderCta).toBeVisible();
    await expect(newOrderCta).toHaveAttribute('href', '/orders/new');
    // En WebKit la hidratación puede completarse después del primer toque: se
    // reintenta hasta que el Router de Next tome la navegación.
    await expect(async () => {
      await newOrderCta.click();
      await expect(page).toHaveURL(/\/orders\/new$/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    // Catálogo y cuenta marcan la sección activa y mantienen la navegación.
    await page.goto('/catalog');
    await expect(nav).toBeVisible();
    await expect(nav.getByTestId('mobile-nav-catalog')).toHaveAttribute('aria-current', 'page');

    await expect(async () => {
      await nav.getByTestId('mobile-nav-account').click();
      await expect(page).toHaveURL(/\/settings\/notifications$/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(nav.getByTestId('mobile-nav-account')).toHaveAttribute('aria-current', 'page');

    await page.context().clearCookies();
    await page.goto('/login');
    await expect(page.getByTestId('mobile-bottom-nav')).toHaveCount(0);
  });

  test('la barra inferior muestra sólo los accesos del rol', async ({ page }) => {
    const cases = [
      {
        user: E2E_USERS.deposit,
        visible: ['panel', 'deposit', 'catalog', 'account'],
        hidden: ['new', 'orders', 'billing'],
      },
      {
        user: E2E_USERS.billing,
        visible: ['panel', 'billing', 'account'],
        hidden: ['new', 'orders', 'deposit', 'catalog'],
      },
      {
        user: E2E_USERS.admin,
        visible: ['panel', 'new', 'deposit', 'billing', 'backoffice'],
        hidden: ['orders', 'catalog', 'account'],
      },
    ] as const;

    for (const entry of cases) {
      await loginThroughUi(page, entry.user);
      const nav = page.getByTestId('mobile-bottom-nav');
      await expect(nav).toBeVisible();

      for (const item of entry.visible) {
        await expect(nav.getByTestId(`mobile-nav-${item}`)).toBeVisible();
      }
      for (const item of entry.hidden) {
        await expect(nav.getByTestId(`mobile-nav-${item}`)).toHaveCount(0);
      }
    }
  });

  test('Volver desde el detalle aterriza en la bandeja y conserva los filtros', async ({
    page,
    request,
  }) => {
    // Este cliente ya tiene pedidos del seed: fuerza el autocompletado que
    // pliega los selects comerciales en el resumen móvil.
    const client = E2E_CLIENTS.dashboard;
    let orderId: string | null = null;

    await loginThroughUi(page, E2E_USERS.seller);

    try {
      // Alta real por la UI móvil: cliente desde la hoja, datos comerciales,
      // una línea y guardado desde el resumen.
      await page.goto('/orders/new');
      await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

      await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
      const clientDialog = page.getByRole('dialog');
      await expect(
        clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' }),
      ).toBeVisible();
      await clientDialog
        .getByPlaceholder('Buscar por código, nombre o localidad...')
        .fill(client.code);
      await clientDialog
        .getByRole('button', { name: new RegExp(`${client.code} - ${client.name}`) })
        .click();
      await expect(clientDialog).toBeHidden();

      // El cliente del seed ya tiene pedidos: el autocompletado pliega los
      // selects en chips. Se espera ese estado y se reabren antes de fijar
      // factura y condición, evitando que la respuesta tardía los oculte.
      const commercialSummary = page.getByTestId('mobile-commercial-summary');
      await expect(commercialSummary).toBeVisible();
      await commercialSummary
        .getByRole('button', { name: 'Editar condición / descuentos' })
        .click();

      const invoiceSelect = page.getByLabel('Tipo de factura').filter({ visible: true });
      await expect(invoiceSelect).toBeVisible();
      await invoiceSelect.selectOption('A');
      await page.getByLabel('Condición de pago').filter({ visible: true }).selectOption('contado');

      const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
      await productSearch.fill(E2E_PRODUCTS.primary.code);
      const productCard = page
        .locator('.cv-product-card')
        .filter({ hasText: E2E_PRODUCTS.primary.code });
      const quantity = productCard.getByRole('spinbutton', {
        name: /^Cantidad en el catálogo de/,
      });
      await quantity.fill('1');
      await expect(quantity).toHaveValue('1');

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
      await page.getByTestId('mobile-cart-button').click();

      const summary = page.getByRole('dialog');
      await expect(
        summary.getByRole('heading', { name: /Resumen y Guardar Pedido/ }),
      ).toBeVisible();

      const createResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          response.request().method() === 'POST',
      );
      await summary.getByRole('button', { name: 'Guardar Pedido (Borrador)' }).click();

      const createdResponse = await createResponse;
      expect(createdResponse.status()).toBe(200);
      orderId = ((await createdResponse.json()) as { order: { _id: string } }).order._id;

      // El alta navega al detalle; el historial inmediato es /orders/new, pero
      // "Volver" debe ignorarlo y regresar siempre a la bandeja.
      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
      await expect(page.getByRole('button', { name: 'Volver', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Abrir menú' })).toBeVisible();

      await page.getByRole('button', { name: 'Volver', exact: true }).click();
      await expect(page).toHaveURL(/\/orders$/);
      await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

      // Al entrar desde una bandeja filtrada, el detalle recuerda la URL exacta
      // y "Volver" restaura estado, fecha y archivados.
      await page.goto('/orders?status=borrador&date=today');
      await expect(page.getByTestId('orders-tray-status-borrador')).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      const card = page.locator(`[data-order-card="true"][data-order-id="${orderId}"]`);
      await expect(card).toBeVisible();
      await card.getByRole('heading', { name: client.name }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));

      await page.getByRole('button', { name: 'Volver', exact: true }).click();
      await expect(page).toHaveURL(/\/orders\?status=borrador&date=today$/);
      await expect(page.getByTestId('orders-tray-status-borrador')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      if (orderId) await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Banner de red y fullscreen en móvil', () => {
  test('offline no tapa Volver ni tema y tocar un input no pide pantalla completa', async ({
    page,
    context,
  }) => {
    // Instrumenta la API antes de que hidrate AutoFullscreen: cualquier
    // requestFullscreen (del componente o de un listener global) suma acá.
    await page.addInitScript(() => {
      let calls = 0;
      Object.defineProperty(window, '__sgiFullscreenCalls', {
        configurable: true,
        get: () => calls,
      });

      const originalRequestFullscreen = Element.prototype.requestFullscreen;
      if (typeof originalRequestFullscreen === 'function') {
        Element.prototype.requestFullscreen = function (
          this: Element,
          ...args: [FullscreenOptions?]
        ) {
          calls += 1;
          return originalRequestFullscreen.apply(this, args);
        };
      }

      const webkitPrototype = Element.prototype as Element & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      const originalWebkitRequestFullscreen = webkitPrototype.webkitRequestFullscreen;
      if (typeof originalWebkitRequestFullscreen === 'function') {
        webkitPrototype.webkitRequestFullscreen = function (this: Element) {
          calls += 1;
          return originalWebkitRequestFullscreen.call(this);
        };
      }
    });

    await loginThroughUi(page);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

    const status = page.getByTestId('network-status');
    await expect(status).toHaveCount(0);

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(status).toBeVisible();
    await expect(status).toContainText('Sin conexión');

    const back = page.getByRole('button', { name: 'Volver', exact: true });
    const theme = page.getByRole('button', { name: 'Cambiar tema' });
    await expect(back).toBeVisible();
    await expect(theme).toBeVisible();

    const statusBox = await status.boundingBox();
    const backBox = await back.boundingBox();
    const themeBox = await theme.boundingBox();

    expect(statusBox).not.toBeNull();
    expect(backBox).not.toBeNull();
    expect(themeBox).not.toBeNull();

    if (statusBox && backBox && themeBox) {
      expect(overlapArea(statusBox, backBox)).toBe(0);
      expect(overlapArea(statusBox, themeBox)).toBe(0);
      expect(await buttonLabelAtCenter(page, backBox)).toBe('Volver');
      expect(await buttonLabelAtCenter(page, themeBox)).toBe('Cambiar tema');
    }

    const themeBefore = await page.locator('html').getAttribute('data-theme');
    await theme.click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      themeBefore === 'dark' ? 'light' : 'dark',
    );

    // Tocar un input no debe disparar requestFullscreen ni saltar el viewport.
    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    await productSearch.click();
    await expect(productSearch).toBeFocused();

    expect(
      await page.evaluate(
        () => (window as Window & { __sgiFullscreenCalls?: number }).__sgiFullscreenCalls ?? 0,
      ),
    ).toBe(0);
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);

    // "Volver" sigue recibiendo el toque aunque el banner esté visible.
    await back.click({ trial: true });
    await expect(status).toBeVisible();

    await context.setOffline(false);
  });
});

// Un contexto nuevo por ancho evita redimensionar ventanas ya abiertas (los
// navegadores móviles emulados no permiten `setViewportSize` de forma estable).
for (const width of MOBILE_WIDTHS) {
  test.describe(`Sin overflow horizontal @ ${width}px`, () => {
    test.use({ viewport: { width, height: 860 } });

    test('panel, alta, bandeja, catálogo y backoffice', async ({ page }) => {
      await page.goto('/login');
      await loginThroughUi(page, E2E_USERS.admin);

      const routes = [
        { path: '/', label: 'panel' },
        { path: '/orders/new', label: 'alta' },
        { path: '/orders', label: 'bandeja' },
        { path: '/catalog', label: 'catálogo de productos' },
        { path: '/catalog/clients', label: 'catálogo de clientes' },
        { path: '/backoffice/products', label: 'backoffice productos' },
        { path: '/backoffice/clients', label: 'backoffice clientes' },
        { path: '/backoffice/brands', label: 'backoffice marcas' },
        { path: '/backoffice/users', label: 'backoffice usuarios' },
        { path: '/backoffice/import', label: 'backoffice importación' },
      ] as const;

      for (const route of routes) {
        await page.goto(route.path);
        await expect(page.locator('body')).toBeVisible();
        await expectMobileErgonomics(page, `${route.label} @ ${width}px`);
      }
    });
  });
}

test.describe('Catálogo y edición en backoffice @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('muestra tarjetas móviles y filtra productos por marca', async ({ page }) => {
    await loginThroughUi(page, E2E_USERS.seller);

    await page.goto('/catalog');
    const productCards = page.getByTestId('catalog-product-cards');
    await expect(productCards).toBeVisible();
    await expect(productCards.getByText(E2E_PRODUCTS.primary.code, { exact: true })).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
    await expectMobileErgonomics(page, 'catálogo de productos');

    await page.getByRole('button', { name: E2E_BRAND.name, exact: true }).click();
    await expect(page).toHaveURL(/[?&]brandId=/);
    await expect(productCards.getByText(E2E_PRODUCTS.primary.code, { exact: true })).toBeVisible();
    await expect(
      productCards.getByText(E2E_PRODUCTS.secondary.code, { exact: true }),
    ).toBeVisible();
    await expect(productCards.getByText(E2E_PRODUCTS.otherBrand.code, { exact: true })).toHaveCount(
      0,
    );
    await expectMobileErgonomics(page, 'catálogo filtrado por marca');

    await page.goto('/catalog/clients');
    const clientCards = page.getByTestId('catalog-client-cards');
    await expect(clientCards).toBeVisible();
    await expect(clientCards.getByText(E2E_CLIENTS.fullFlow.code, { exact: true })).toBeVisible();
    await expect(clientCards.getByText(E2E_CLIENTS.fullFlow.name, { exact: true })).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
    await expectMobileErgonomics(page, 'catálogo de clientes');
  });

  test('editar desde una tarjeta lleva al formulario, lo enfoca y lo señala', async ({ page }) => {
    await loginThroughUi(page, E2E_USERS.admin);

    await page.goto('/backoffice/products');
    const productCard = page
      .getByTestId('backoffice-product-card')
      .filter({ hasText: E2E_PRODUCTS.primary.code });
    await expect(productCard).toBeVisible();
    await productCard.getByRole('button', { name: 'Editar' }).click();
    await expect(page.getByTestId('product-editing-indicator')).toBeVisible();
    await expect(page.getByTestId('product-editing-indicator')).toContainText(
      E2E_PRODUCTS.primary.code,
    );
    await expect(page.getByPlaceholder('Ej: C1020 o 5040')).toBeFocused();

    await page.goto('/backoffice/clients');
    const clientCard = page
      .getByTestId('backoffice-client-card')
      .filter({ hasText: E2E_CLIENTS.fullFlow.code });
    await expect(clientCard).toBeVisible();
    await clientCard.getByRole('button', { name: 'Editar' }).click();
    await expect(page.getByTestId('client-editing-indicator')).toBeVisible();
    await expect(page.getByTestId('client-editing-indicator')).toContainText(
      E2E_CLIENTS.fullFlow.code,
    );
    await expect(page.getByPlaceholder('Ej: CLI001')).toBeFocused();

    await page.goto('/backoffice/brands');
    const brandCard = page.getByTestId('backoffice-brand-card').filter({ hasText: E2E_BRAND.name });
    await expect(brandCard).toBeVisible();
    await brandCard.getByRole('button', { name: 'Editar' }).click();
    await expect(page.getByTestId('brand-editing-indicator')).toBeVisible();
    await expect(page.getByTestId('brand-editing-indicator')).toContainText(E2E_BRAND.name);
    await expect(page.getByPlaceholder('Ej: NovaFarma, BioSalud')).toBeFocused();
  });

  test('el alta colapsada deja el buscador a la vista y se despliega al editar', async ({
    page,
  }) => {
    await loginThroughUi(page, E2E_USERS.admin);

    await page.goto('/backoffice/products');
    const productSearch = page.getByPlaceholder('Buscar por código, nombre o marca...');
    await expect(productSearch).toBeVisible();

    const productSearchBox = await productSearch.boundingBox();
    expect(productSearchBox).not.toBeNull();
    expect(productSearchBox!.y).toBeLessThanOrEqual(350);

    const firstProductCard = page.getByTestId('backoffice-product-card').first();
    await expect(firstProductCard).toBeVisible();
    const firstProductCardBox = await firstProductCard.boundingBox();
    expect(firstProductCardBox).not.toBeNull();
    expect(firstProductCardBox!.y).toBeLessThan(844);

    // El formulario arranca plegado y se abre desde la barra compacta.
    const productToggle = page.getByRole('button', { name: '+ Nuevo Producto' });
    await expect(productToggle).toBeVisible();
    await expect(productToggle).toHaveAttribute('aria-expanded', 'false');
    await productToggle.click();
    await expect(page.getByPlaceholder('Ej: C1020 o 5040')).toBeFocused();
    await page.getByRole('button', { name: 'Ocultar formulario' }).click();
    await expect(productToggle).toBeVisible();
    await expect(page.getByPlaceholder('Ej: C1020 o 5040')).toBeHidden();

    // "Editar" abre el formulario automáticamente y conserva el foco.
    await firstProductCard.getByRole('button', { name: 'Editar' }).click();
    await expect(page.getByTestId('product-editing-indicator')).toBeVisible();
    await expect(page.getByPlaceholder('Ej: C1020 o 5040')).toBeFocused();
    await page.getByRole('button', { name: 'Cancelar edición' }).click();
    await expect(productToggle).toBeVisible();

    await page.goto('/backoffice/clients');
    const clientSearch = page.getByPlaceholder(
      'Buscar por código, nombre, localidad, provincia...',
    );
    await expect(clientSearch).toBeVisible();
    const clientSearchBox = await clientSearch.boundingBox();
    expect(clientSearchBox).not.toBeNull();
    expect(clientSearchBox!.y).toBeLessThanOrEqual(350);

    const firstClientCard = page.getByTestId('backoffice-client-card').first();
    await expect(firstClientCard).toBeVisible();
    const firstClientCardBox = await firstClientCard.boundingBox();
    expect(firstClientCardBox).not.toBeNull();
    expect(firstClientCardBox!.y).toBeLessThan(844);

    const clientToggle = page.getByRole('button', { name: '+ Nuevo Cliente' });
    await expect(clientToggle).toBeVisible();
    await clientToggle.click();
    await expect(page.getByPlaceholder('Ej: CLI001')).toBeFocused();
    await page.getByRole('button', { name: 'Ocultar formulario' }).click();
    await expect(clientToggle).toBeVisible();
  });

  test('edita los descuentos desde la tarjeta móvil y conserva el scroll', async ({ page }) => {
    const client = E2E_CLIENTS.fullFlow;

    await loginThroughUi(page, E2E_USERS.admin);
    const clientId = await clientIdByCode(page, client.code);

    const detailResponse = await page.request.get(`/api/clients/${clientId}`);
    expect(detailResponse.status()).toBe(200);
    const original = (
      (await detailResponse.json()) as {
        client: {
          code: string;
          name: string;
          address: string;
          localidad: string;
          province: string;
          generalDiscount: number;
          brandDiscounts: Array<{ brandId: string; discountPercentage: number }>;
        };
      }
    ).client;

    try {
      await page.goto('/backoffice/clients');
      const card = page
        .getByTestId('backoffice-client-card')
        .filter({ hasText: E2E_CLIENTS.fullFlow.code });
      await expect(card).toBeVisible();

      // El alta plegada acorta la página: forzamos un scroll real hasta la
      // tarjeta para seguir verificando que la edición rápida no lo pierde.
      await card.evaluate((element) => {
        const top = element.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, Math.max(0, top - 120));
      });

      await card.getByRole('button', { name: 'Cambiar descuentos' }).click();

      const modal = page.getByTestId('quick-client-discounts-modal');
      await expect(modal).toBeVisible();
      await expect(modal.getByText('Cambiar descuentos', { exact: true })).toBeVisible();

      const scrollBeforeSave = await page.evaluate(() => window.scrollY);
      expect(scrollBeforeSave).toBeGreaterThan(0);

      await modal.getByLabel('Descuento general (%)').fill('12');

      const saveResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/clients/${clientId}` &&
          response.request().method() === 'PUT',
      );
      await modal.getByRole('button', { name: 'Guardar descuentos' }).click();

      expect((await saveResponse).status()).toBe(200);
      await expect(modal).toBeHidden();

      // La tarjeta se actualiza en el lugar, sin recargar ni saltar al inicio.
      await expect(card).toContainText('12% desc.');
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeSave);

      const persistedResponse = await page.request.get(`/api/clients/${clientId}`);
      expect(persistedResponse.status()).toBe(200);
      const persisted = (await persistedResponse.json()) as {
        client: { generalDiscount: number };
      };
      expect(persisted.client.generalDiscount).toBe(12);
    } finally {
      const restore = await page.request.put(`/api/clients/${clientId}`, {
        data: {
          code: original.code,
          name: original.name,
          address: original.address,
          localidad: original.localidad,
          province: original.province,
          generalDiscount: original.generalDiscount,
          brandDiscounts: original.brandDiscounts.map((discount) => ({
            brandId: discount.brandId,
            discountPercentage: discount.discountPercentage,
          })),
        },
      });
      expect(restore.status()).toBe(200);
    }
  });

  test('las pestañas de backoffice cambian de módulo sin overflow horizontal', async ({ page }) => {
    await loginThroughUi(page, E2E_USERS.admin);
    await page.goto('/backoffice/products');

    const tabs = page.getByTestId('backoffice-tabs');
    await expect(tabs).toBeVisible();
    await expect(page.getByTestId('backoffice-tab-products')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-backoffice')).toHaveAttribute(
      'href',
      '/backoffice/products',
    );
    await expect(page.getByTestId('mobile-nav-backoffice')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('mobile-nav-account')).toHaveCount(0);
    await expectNoHorizontalOverflow(page, 'backoffice productos con pestañas @ 390px');

    await page.getByTestId('backoffice-tab-clients').click();
    await expect(page).toHaveURL(/\/backoffice\/clients$/);
    await expect(page.getByTestId('backoffice-tab-clients')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('backoffice-client-card').first()).toBeVisible();
    await expectNoHorizontalOverflow(page, 'backoffice clientes con pestañas @ 390px');
  });
});

test.describe('Primera página y borrador desde catálogo @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('el alta ya muestra productos y permite sumarlos desde el catálogo', async ({ page }) => {
    const product = E2E_PRODUCTS.primary;

    await loginThroughUi(page, E2E_USERS.seller);

    // La primera página viene resuelta por el servidor: los productos se ven
    // sin tocar ninguna marca ni esperar un fetch de montaje.
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();

    // Desde el catálogo se suma una unidad al borrador local.
    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'Catálogo de Productos' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    const productCards = page.getByTestId('catalog-product-cards');
    const primaryCard = productCards.filter({ hasText: product.code });
    await expect(primaryCard).toBeVisible();
    await primaryCard
      .getByRole('button', { name: `+ Pedido: ${product.name}`, exact: true })
      .click();

    const draftChip = page.getByTestId('catalog-draft-chip');
    await expect(draftChip).toContainText('Pedido en borrador: 1 ítems (1 u.)');

    // El atajo +6 suma media docena sin abrir el teclado y el chip refleja las
    // unidades totales del borrador.
    const plus6 = primaryCard.getByRole('button', {
      name: `Sumar 6 unidades de ${product.name}`,
    });
    await expect(async () => {
      await plus6.click();
      await expect(draftChip).toContainText('(7 u.)', { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(draftChip).toContainText('Pedido en borrador: 1 ítems (7 u.) · Ir al pedido');
    await draftChip.click();

    // El borrador se restaura en el alta y el producto aparece en el carrito.
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(page.getByTestId('selected-products-filter')).toHaveText('Seleccionados (1)');
    const cartLine = page.locator('.cv-product-card').filter({ hasText: product.code });
    await expect(
      cartLine.getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }),
    ).toHaveValue('7');
  });
});

test.describe('Autocompletado comercial y catálogo sticky @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('completa factura y pago del último pedido, mantiene el buscador sticky y muestra el subtotal de la línea', async ({
    page,
    request,
  }) => {
    const client = E2E_CLIENTS.fullFlow;
    const product = E2E_PRODUCTS.primary;
    let previousOrderId: string | null = null;

    await loginThroughUi(page, E2E_USERS.seller);
    const clientId = await clientIdByCode(page, client.code);
    const productId = await productIdByCode(page, product.code);

    try {
      // Pedido previo determinista: el autocompletado debe tomar factura B y
      // cuenta corriente del pedido más reciente de este cliente.
      const creation = await page.request.post('/api/orders', {
        data: {
          clientId,
          items: [{ productId, requestedQuantity: 1 }],
          invoiceType: 'B',
          paymentCondition: 'cuenta_corriente',
          clientRequestId: `e2e-commercial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(creation.status()).toBe(200);
      previousOrderId = ((await creation.json()) as { order: { _id: string } }).order._id;

      await page.goto('/orders/new');
      await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

      await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
      const clientDialog = page.getByRole('dialog');
      await expect(
        clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' }),
      ).toBeVisible();
      await clientDialog
        .getByPlaceholder('Buscar por código, nombre o localidad...')
        .fill(client.code);
      await clientDialog
        .getByRole('button', { name: new RegExp(`${client.code} - ${client.name}`) })
        .click();
      await expect(clientDialog).toBeHidden();

      // La consulta de lastOrder completa los datos comerciales y la tarjeta
      // se pliega en chips para dejar el catálogo a la vista.
      const commercialSummary = page.getByTestId('mobile-commercial-summary');
      await expect(commercialSummary).toBeVisible();
      await expect(commercialSummary).toContainText('Factura B');
      await expect(commercialSummary).toContainText('Cuenta corriente');
      await expect(commercialSummary).toContainText('Desc. 5%');
      await expect(page.getByLabel('Tipo de factura').filter({ visible: true })).toHaveCount(0);

      // El botón reabre los selects con los valores autocompletados.
      await commercialSummary
        .getByRole('button', { name: 'Editar condición / descuentos' })
        .click();
      await expect(page.getByLabel('Tipo de factura').filter({ visible: true })).toHaveValue('B');
      await expect(page.getByLabel('Condición de pago').filter({ visible: true })).toHaveValue(
        'cuenta_corriente',
      );
      await commercialSummary
        .getByRole('button', { name: 'Ocultar condición / descuentos' })
        .click();

      // Sumar unidades desde la tarjeta muestra el subtotal de la línea con el
      // descuento vigente del cliente (5% sobre 2 x $1000).
      const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
      await productSearch.fill(product.code);
      const card = page.locator('.cv-product-card').filter({ hasText: product.code });
      await expect(card).toBeVisible();

      const quantity = card.getByRole('spinbutton', {
        name: /^Cantidad en el catálogo de/,
      });
      await quantity.fill('2');
      await expect(quantity).toHaveValue('2');
      await expect(card.getByTestId('catalog-in-cart-badge')).toContainText(
        'En carrito: 2 u. · $1900.00',
      );

      // Con varias tarjetas la página vuelve a scrollear: el buscador y los
      // filtros de marca quedan pegados debajo de la barra superior.
      await page.getByRole('button', { name: 'Limpiar búsqueda de productos' }).click();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

      const toolbar = page.getByTestId('catalog-sticky-toolbar');
      await expect(toolbar).toBeVisible();
      await expect
        .poll(async () => {
          const box = await toolbar.boundingBox();
          return box ? Math.round(box.y) : null;
        })
        .toBe(64);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

      // El buscador sigue operativo en cualquier punto del scroll.
      await productSearch.fill(E2E_PRODUCTS.secondary.code);
      await expect(productSearch).toHaveValue(E2E_PRODUCTS.secondary.code);
    } finally {
      if (previousOrderId) await deleteOrderAsAdmin(request, previousOrderId);
    }
  });
});

test.describe('Borrador y cliente combinados desde el catálogo @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('usa el carrito del catálogo con el cliente elegido y persiste al recargar', async ({
    page,
  }) => {
    const client = E2E_CLIENTS.fullFlow;
    const products = [E2E_PRODUCTS.primary, E2E_PRODUCTS.secondary] as const;

    await loginThroughUi(page, E2E_USERS.seller);

    // Suma dos productos al borrador desde la pestaña de productos.
    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'Catálogo de Productos' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    const productCards = page.getByTestId('catalog-product-cards');

    for (const product of products) {
      const card = productCards.filter({ hasText: product.code });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: `+ Pedido: ${product.name}`, exact: true }).click();
    }

    await expect(page.getByTestId('catalog-draft-chip')).toContainText(
      'Pedido en borrador: 2 ítems',
    );

    // La pestaña de clientes refleja el carrito y ofrece continuidad.
    await page
      .getByRole('navigation', { name: 'Secciones del catálogo' })
      .getByRole('link', { name: 'Clientes' })
      .click();
    await expect(page).toHaveURL(/\/catalog\/clients$/);
    await expect(page.getByRole('heading', { name: 'Catálogo de Clientes' })).toBeVisible();

    const clientCard = page
      .getByTestId('catalog-client-cards')
      .locator(':scope > div')
      .filter({ hasText: client.code });
    await expect(clientCard).toBeVisible();

    const useDraftButton = clientCard.getByRole('button', {
      name: 'Usar en pedido (2 ítems)',
      exact: true,
    });
    await expect(useDraftButton).toBeVisible();
    await useDraftButton.click();

    // El alta abre con el cliente solicitado, sin el query transitorio, y con
    // el carrito que venía del catálogo.
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `${client.code} - ${client.name}`, exact: true }),
    ).toBeVisible();

    const selectedFilter = page.getByTestId('selected-products-filter');
    await expect(selectedFilter).toHaveText('Seleccionados (2)');
    await expect(selectedFilter).toHaveAttribute('aria-pressed', 'true');

    const orderCards = page.getByTestId('order-catalog-product-card');
    const primaryCard = orderCards.filter({ hasText: products[0].code });
    const secondaryCard = orderCards.filter({ hasText: products[1].code });
    await expect(primaryCard).toBeVisible();
    await expect(secondaryCard).toBeVisible();

    const primaryQuantity = primaryCard.getByRole('spinbutton', {
      name: /^Cantidad en el catálogo de/,
    });
    await expect(primaryQuantity).toHaveValue('1');
    await expect(
      secondaryCard.getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }),
    ).toHaveValue('1');

    // Cambia una cantidad y espera el debounce del autoguardado.
    await primaryQuantity.fill('4');
    await expect(primaryQuantity).toHaveValue('4');
    await expect
      .poll(() =>
        page.evaluate(() => {
          for (const key of Object.keys(window.localStorage)) {
            if (!key.startsWith('sgi_order_draft:')) continue;
            const raw = window.localStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw) as { quantities?: Record<string, number> };
            return Object.values(parsed.quantities ?? {});
          }
          return [];
        }),
      )
      .toContain(4);

    // La recarga ya no vuelve a aplicar `?clientId=`: restaura el borrador
    // actualizado, con el cliente y las cantidades combinadas.
    await page.reload();
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `${client.code} - ${client.name}`, exact: true }),
    ).toBeVisible();

    const restoredFilter = page.getByTestId('selected-products-filter');
    await expect(restoredFilter).toHaveText('Seleccionados (2)');
    await expect(restoredFilter).toHaveAttribute('aria-pressed', 'true');
    await expect(
      orderCards
        .filter({ hasText: products[0].code })
        .getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }),
    ).toHaveValue('4');
    await expect(
      orderCards
        .filter({ hasText: products[1].code })
        .getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }),
    ).toHaveValue('1');
  });
});

test.describe('Colas del panel @ 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('tocar una cola abre la bandeja filtrada sin overflow horizontal', async ({ page }) => {
    await page.goto('/login');
    await loginThroughUi(page, E2E_USERS.seller);

    await page.getByTestId('dashboard-count-paralizado').click();
    await expect(page).toHaveURL(/\/orders\?status=paralizado$/);
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

    // El chip llega activo desde `?status=` y la primera página ya viene
    // acotada por ese estado (server-first, sin fetch de montaje).
    await expect(page.getByTestId('orders-tray-status-paralizado')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('orders-tray-status-all')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    const cards = page.locator('[data-order-card="true"]');
    await expect(cards.first()).toBeVisible();

    // Puede haber más de un paralizado (otros specs dejan pedidos de prueba),
    // pero ninguno de otro estado debe colarse en la bandeja filtrada.
    const filteredCount = await cards.count();
    expect(filteredCount).toBeGreaterThan(0);

    for (let index = 0; index < filteredCount; index += 1) {
      await expect(cards.nth(index)).toContainText('Paralizado');
    }

    await expectMobileErgonomics(page, 'bandeja filtrada desde el panel');

    // En mobile el filtro de fecha vive plegado junto a los estados: se abre
    // con un toque, envía startDate/endDate a la API y vuelve a plegarse.
    const dateToggle = page.getByTestId('orders-tray-date-toggle');
    await expect(dateToggle).toContainText('Fecha: Todas');
    await expect(page.getByTestId('orders-tray-date-filters')).toBeHidden();
    await dateToggle.click();
    await expect(page.getByTestId('orders-tray-date-filters')).toBeVisible();

    const dateResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());

      return (
        url.pathname === '/api/orders' &&
        response.request().method() === 'GET' &&
        url.searchParams.has('startDate') &&
        url.searchParams.has('endDate')
      );
    });

    await page.getByTestId('orders-tray-date-today').click();
    expect((await dateResponse).status()).toBe(200);
    await expect(page.getByTestId('orders-tray-date-today')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dateToggle).toContainText('Fecha: Hoy');
    await expect(page.getByTestId('orders-tray-date-filters')).toBeHidden();
    await expect(cards.first()).toBeVisible();
    await expect(cards.first()).toContainText('Paralizado');
    await expectNoHorizontalOverflow(page, 'bandeja filtrada con fecha @ 360px');
  });
});

test.describe('Notificación privada del vendedor @ 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('depósito paraliza el pedido y el vendedor lo abre desde la campana', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const productId = await productIdByCode(page, E2E_PRODUCTS.primary.code);
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId, requestedQuantity: 2 },
    ]);

    try {
      // Depósito paraliza el pedido del vendedor con un comentario/motivo.
      await loginThroughUi(page, E2E_USERS.deposit);
      const detailResponse = await page.request.get(`/api/orders/${orderId}`);
      expect(detailResponse.status()).toBe(200);
      const { order } = (await detailResponse.json()) as { order: E2EOrderDetail };

      const updateResponse = await page.request.put(`/api/orders/${orderId}`, {
        data: {
          version: order.version ?? 0,
          status: 'paralizado',
          comment: 'Falta stock para el cliente',
        },
      });
      expect(updateResponse.status()).toBe(200);

      await loginThroughUi(page, E2E_USERS.seller);
      await page.getByRole('button', { name: /^Abrir bandeja de notificaciones/ }).click();

      const dialog = page.getByRole('dialog', { name: 'Notificaciones' });
      await expect(dialog).toBeVisible();

      // El vendedor no puede filtrar por las bandejas internas de depósito o
      // facturación: su campana es privada.
      await dialog.getByRole('button', { name: 'Configurar filtros de notificaciones' }).click();
      await expect(dialog.getByRole('combobox')).toHaveCount(0);
      await expect(
        dialog.getByText('Recibís alertas privadas de tus propios pedidos.'),
      ).toBeVisible();

      const alert = dialog
        .locator('[data-notification-item="true"]')
        .filter({ hasText: 'Pedido Paralizado en Depósito' })
        .filter({ hasText: E2E_CLIENTS.mobileControl.name })
        .first();

      await expect(alert).toBeVisible();
      await alert.click();

      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
      await expectNoHorizontalOverflow(page, 'detalle abierto desde la campana @360px');
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Campana en vivo por SSE @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('el alta del vendedor actualiza la campana sin un GET extra de la bandeja', async ({
    page,
    request,
  }) => {
    let orderId: string | undefined;
    let notificationGets = 0;

    page.on('request', (requestEvent) => {
      if (
        requestEvent.method() === 'GET' &&
        new URL(requestEvent.url()).pathname === '/api/users/notifications'
      ) {
        notificationGets += 1;
      }
    });

    try {
      const initialInbox = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/users/notifications',
        { timeout: 30_000 },
      );
      const sseResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/events' && response.status() === 200,
        { timeout: 30_000 },
      );

      await loginThroughUi(page, E2E_USERS.deposit);
      await initialInbox;
      expect((await sseResponse).status()).toBe(200);

      // La bandeja queda abierta antes del alta: sin el payload SSE, la alerta
      // recién aparecería con el polling de seguridad (60 s con SSE sano).
      await page.getByRole('button', { name: /^Abrir bandeja de notificaciones/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Notificaciones' });
      await expect(dialog).toBeVisible();

      // Deja asentar la carga inicial (y un posible doble efecto de dev) antes
      // de tomar la línea base de requests.
      await page.waitForTimeout(1_000);
      const baselineGets = notificationGets;

      const login = await request.post('/api/auth/login', { data: E2E_USERS.seller });
      expect(login.status()).toBe(200);

      const clientsResponse = await request.get(
        `/api/clients?search=${encodeURIComponent(E2E_CLIENTS.realtime.code)}&limit=20`,
      );
      expect(clientsResponse.status()).toBe(200);
      const clients = (await clientsResponse.json()) as {
        clients: Array<{ _id: string; code: string }>;
      };
      const client = clients.clients.find((item) => item.code === E2E_CLIENTS.realtime.code);
      expect(client).toBeTruthy();

      const productsResponse = await request.get(
        `/api/products?search=${encodeURIComponent(E2E_PRODUCTS.secondary.code)}&limit=20`,
      );
      expect(productsResponse.status()).toBe(200);
      const products = (await productsResponse.json()) as {
        products: Array<{ _id: string; code: string }>;
      };
      const product = products.products.find((item) => item.code === E2E_PRODUCTS.secondary.code);
      expect(product).toBeTruthy();

      const creation = await request.post('/api/orders', {
        data: {
          clientId: client!._id,
          items: [{ productId: product!._id, requestedQuantity: 1 }],
          invoiceType: 'A',
          paymentCondition: 'contado',
          clientRequestId: `e2e-sse-bell-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(creation.status()).toBe(200);
      orderId = ((await creation.json()) as { order: { _id: string } }).order._id;

      const alert = dialog
        .locator('[data-notification-item="true"]')
        .filter({ hasText: 'Nuevo Pedido (Borrador)' })
        .filter({ hasText: E2E_CLIENTS.realtime.name })
        .first();

      await expect(alert).toBeVisible({ timeout: 15_000 });
      expect(notificationGets).toBe(baselineGets);
    } finally {
      if (orderId) await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Bandeja compacta con contexto @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('la primera tarjeta entra sin scroll y adelanta productos, faltantes y comentario', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 3 },
      { productId: secondaryId, requestedQuantity: 2 },
      { productId: otherBrandId, requestedQuantity: 1 },
    ]);

    try {
      // Depósito deja una línea con faltante y un motivo; el comentario también
      // debe verse en la tarjeta sin abrir el detalle.
      await loginThroughUi(page, E2E_USERS.deposit);
      const detailResponse = await page.request.get(`/api/orders/${orderId}`);
      expect(detailResponse.status()).toBe(200);
      const { order } = (await detailResponse.json()) as { order: E2EOrderDetail };

      const updateResponse = await page.request.put(`/api/orders/${orderId}`, {
        data: {
          version: order.version ?? 0,
          status: 'paralizado',
          comment: 'Falta stock del segundo producto',
          items: order.items.map((item, index) => ({
            _id: item._id,
            requestedQuantity: item.requestedQuantity,
            verifiedQuantity: index === 1 ? 0 : item.requestedQuantity,
            isPending: index === 1,
            ...(index === 1 ? { pendingReason: 'Sin stock en depósito' } : {}),
          })),
        },
      });
      expect(updateResponse.status()).toBe(200);

      await loginThroughUi(page, E2E_USERS.seller);
      await page.goto('/orders');
      await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();
      // El subtítulo largo se oculta en mobile para liberar altura.
      await expect(
        page.getByText('Consultá el estado, los importes y el detalle de los pedidos que creaste.'),
      ).toBeHidden();

      const firstCard = page.locator('[data-order-card="true"]').first();
      await expect(firstCard).toHaveAttribute('data-order-id', orderId);

      const preview = firstCard.getByTestId('order-products-preview');
      await expect(preview).toContainText('3x Producto E2E Principal');
      await expect(preview).toContainText('2x Producto E2E Secundario');
      await expect(preview).toContainText('(+1 más)');

      const pendingAlert = firstCard.getByTestId('order-pending-alert');
      await expect(pendingAlert).toHaveAttribute('data-pending-lines', '1');
      await expect(pendingAlert).toContainText('1 línea con faltante');
      await expect(pendingAlert).toContainText('Sin stock en depósito');

      await expect(firstCard.getByTestId('order-last-comment')).toContainText(
        'Falta stock del segundo producto',
      );

      // Sin scrollear, la primera tarjeta completa (incluido el adelanto) ya
      // está dentro del viewport inicial de 390x844.
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const cardBox = await firstCard.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(cardBox!.y).toBeGreaterThanOrEqual(0);
      expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(viewportHeight);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      await expectNoHorizontalOverflow(page, 'bandeja compacta @390px');
      await expectMobileErgonomics(page, 'bandeja compacta @390px');

      // El chip de fecha se pliega y despliega sin agregar overflow.
      const dateToggle = page.getByTestId('orders-tray-date-toggle');
      const dateFilters = page.getByTestId('orders-tray-date-filters');
      await expect(dateToggle).toContainText('Fecha: Todas');
      await expect(dateFilters).toBeHidden();

      // WebKit puede completar la hidratación después del primer toque: se
      // reintenta hasta que React refleje el panel plegado/desplegado.
      await expect(async () => {
        await dateToggle.click();
        await expect(dateFilters).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await expectNoHorizontalOverflow(page, 'bandeja con fecha desplegada @390px');

      await expect(async () => {
        await dateToggle.click();
        await expect(dateFilters).toBeHidden({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Búsqueda de pedidos por prefijo @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('encuentra por cliente o producto y limpia con el botón X', async ({ page, request }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
    ]);

    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 1 },
      { productId: secondaryId, requestedQuantity: 1 },
    ]);

    try {
      await page.goto('/orders');
      await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

      const search = page.getByPlaceholder('Buscar por cliente, producto, código o #pedido...');
      const clear = page.getByRole('button', { name: 'Limpiar búsqueda de pedidos' });
      const orderCard = page.locator(`[data-order-card="true"][data-order-id="${orderId}"]`);

      // WebKit puede completar la hidratación después del primer `fill`; sin
      // handlers React el texto queda en el DOM pero no dispara la búsqueda.
      await waitForReactHydration(
        page,
        'input[placeholder="Buscar por cliente, producto, código o #pedido..."]',
      );

      // Prefijo de 4 letras del cliente, con debounce de la bandeja.
      const clientResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/orders' &&
          response.request().method() === 'GET' &&
          url.searchParams.get('search') === 'mobi'
        );
      });
      await search.fill('mobi');
      expect((await clientResponse).status()).toBe(200);
      await expect(orderCard).toBeVisible();

      // Nombre de un producto incluido en el pedido.
      const productResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/orders' &&
          response.request().method() === 'GET' &&
          url.searchParams.get('search') === 'Principal'
        );
      });
      await search.fill('Principal');
      expect((await productResponse).status()).toBe(200);
      await expect(orderCard).toBeVisible();

      // La X mide 44x44 px y restaura el listado completo sin recargar.
      await expect(clear).toBeVisible();
      const clearBox = await clear.boundingBox();
      expect(clearBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(clearBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      const clearedResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/orders' &&
          response.request().method() === 'GET' &&
          !url.searchParams.has('search')
        );
      });
      await clear.click();
      expect((await clearedResponse).status()).toBe(200);
      await expect(search).toHaveValue('');
      await expect(clear).toBeHidden();
      await expect(orderCard).toBeVisible();
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Búsqueda persistente y badge de borrador @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Volver conserva la búsqueda y el catálogo refleja el borrador en la barra', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const productId = await productIdByCode(page, E2E_PRODUCTS.primary.code);

    const matchingOrderId = await createMobileErgonomicsOrder(
      page,
      E2E_CLIENTS.mobileControl.code,
      [{ productId, requestedQuantity: 1 }],
    );
    const otherOrderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.realtime.code, [
      { productId, requestedQuantity: 1 },
    ]);

    try {
      await page.goto('/orders');
      await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

      const search = page.getByPlaceholder('Buscar por cliente, producto, código o #pedido...');
      await waitForReactHydration(
        page,
        'input[placeholder="Buscar por cliente, producto, código o #pedido..."]',
      );

      const searchResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/orders' &&
          response.request().method() === 'GET' &&
          url.searchParams.get('search') === 'Mobile Control'
        );
      });

      await search.fill('Mobile Control');
      expect((await searchResponse).status()).toBe(200);

      const matchingCard = page.locator(
        `[data-order-card="true"][data-order-id="${matchingOrderId}"]`,
      );
      const otherCard = page.locator(`[data-order-card="true"][data-order-id="${otherOrderId}"]`);

      await expect(matchingCard).toBeVisible();
      await expect(otherCard).toHaveCount(0);
      await expect(page).toHaveURL(/[?&]search=Mobile(\+|%20)Control/);

      // El detalle lee los filtros guardados por la bandeja: "Volver" debe
      // restaurar el término, no sólo estado/fecha/archivados.
      await matchingCard.getByRole('heading', { name: E2E_CLIENTS.mobileControl.name }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${matchingOrderId}$`));
      await page.getByRole('button', { name: 'Volver', exact: true }).click();

      await expect(page).toHaveURL(/\/orders\?[^#]*search=Mobile(\+|%20)Control/);
      await expect(search).toHaveValue('Mobile Control');
      await expect(matchingCard).toBeVisible();
      await expect(otherCard).toHaveCount(0);

      // El borrador activo se ve en el tab "Nuevo" sin cambiar el ancho de la
      // barra: el badge se posiciona sobre el ícono, fuera del flujo.
      await page.goto('/catalog');
      await expect(page.getByRole('heading', { name: 'Catálogo de Productos' })).toBeVisible();
      await page.waitForLoadState('networkidle');

      const nav = page.getByTestId('mobile-bottom-nav');
      const newTab = nav.getByTestId('mobile-nav-new');
      const widthBefore = (await newTab.boundingBox())?.width ?? 0;
      await expect(nav.getByTestId('mobile-nav-draft-badge')).toHaveCount(0);

      const productCard = page
        .getByTestId('catalog-product-cards')
        .filter({ hasText: E2E_PRODUCTS.primary.code });
      await expect(productCard).toBeVisible();
      await productCard
        .getByRole('button', { name: `+ Pedido: ${E2E_PRODUCTS.primary.name}`, exact: true })
        .click();

      const badge = nav.getByTestId('mobile-nav-draft-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('1');

      const widthAfter = (await newTab.boundingBox())?.width ?? 0;
      expect(widthAfter).toBe(widthBefore);
      await expectNoHorizontalOverflow(page, 'catálogo con badge de borrador @390px');
    } finally {
      await deleteOrderAsAdmin(request, matchingOrderId);
      await deleteOrderAsAdmin(request, otherOrderId);
    }
  });
});

test.describe('Revalidación al volver a foco @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('una ausencia corta no consulta y una larga revalida el detalle', async ({
    page,
    request,
  }) => {
    // Reloj y visibilidad controlados: el test no espera 40 s reales ni depende
    // de que el navegador emita visibilitychange al cambiar de pestaña.
    await page.addInitScript(() => {
      const realNow = Date.now.bind(Date);
      let offset = 0;
      let hidden = false;

      Object.defineProperty(window, '__setVisibilityOffset', {
        configurable: true,
        value: (ms: number) => {
          offset = ms;
        },
      });
      Object.defineProperty(window, '__setDocumentHidden', {
        configurable: true,
        value: (value: boolean) => {
          hidden = value;
          document.dispatchEvent(new Event('visibilitychange'));
        },
      });

      Date.now = () => realNow() + offset;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hidden,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      });
    });

    await loginThroughUi(page, E2E_USERS.seller);
    const productId = await productIdByCode(page, E2E_PRODUCTS.primary.code);
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId, requestedQuantity: 1 },
    ]);

    try {
      let detailRequests = 0;
      const detailPath = `/api/orders/${orderId}`;

      page.on('request', (requestEvent) => {
        if (
          requestEvent.method() === 'GET' &&
          new URL(requestEvent.url()).pathname === detailPath
        ) {
          detailRequests += 1;
        }
      });

      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole('button', { name: 'Volver', exact: true })).toBeVisible();
      await page.waitForTimeout(500);
      const baseline = detailRequests;

      await page.evaluate(() =>
        (window as Window & { __setDocumentHidden: (value: boolean) => void }).__setDocumentHidden(
          true,
        ),
      );
      await page.waitForTimeout(2_000);
      await page.evaluate(() =>
        (window as Window & { __setDocumentHidden: (value: boolean) => void }).__setDocumentHidden(
          false,
        ),
      );
      await page.waitForTimeout(1_000);

      expect(detailRequests, 'una ausencia de 2 s no debe disparar un GET nuevo del detalle').toBe(
        baseline,
      );

      await page.evaluate(() =>
        (window as Window & { __setDocumentHidden: (value: boolean) => void }).__setDocumentHidden(
          true,
        ),
      );
      await page.evaluate(() =>
        (
          window as unknown as { __setVisibilityOffset: (ms: number) => void }
        ).__setVisibilityOffset(40_000),
      );
      await page.evaluate(() =>
        (window as Window & { __setDocumentHidden: (value: boolean) => void }).__setDocumentHidden(
          false,
        ),
      );

      await expect.poll(() => detailRequests, { timeout: 10_000 }).toBeGreaterThan(baseline);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Modo manos libres en depósito @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('activa pantalla encendida, la persiste y libera el sentinel al salir', async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      interface FakeSentinel {
        released: boolean;
        releaseCalls: number;
        release: () => Promise<void>;
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      }

      const requests: string[] = [];
      const sentinels: FakeSentinel[] = [];

      const fakeWakeLock = {
        request: async (type: string) => {
          requests.push(type);
          const listeners = new Set<() => void>();
          const sentinel: FakeSentinel = {
            released: false,
            releaseCalls: 0,
            async release() {
              sentinel.releaseCalls += 1;
              if (sentinel.released) return;
              sentinel.released = true;
              for (const listener of listeners) listener();
            },
            addEventListener(listenerType, listener) {
              if (listenerType === 'release') listeners.add(listener);
            },
            removeEventListener(listenerType, listener) {
              if (listenerType === 'release') listeners.delete(listener);
            },
          };
          sentinels.push(sentinel);
          return sentinel;
        },
      };

      const define = (target: object, property: string, value: unknown): boolean => {
        try {
          Object.defineProperty(target, property, { configurable: true, value });
          return true;
        } catch {
          return false;
        }
      };

      if (!define(navigator, 'wakeLock', fakeWakeLock)) {
        define(Navigator.prototype, 'wakeLock', fakeWakeLock);
      }

      Object.defineProperty(window, '__wakeLockTest', {
        configurable: true,
        value: { requests, sentinels },
      });
    });

    await loginThroughUi(page, E2E_USERS.seller);
    const productId = await productIdByCode(page, E2E_PRODUCTS.primary.code);
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId, requestedQuantity: 2 },
    ]);

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${orderId}`);
      await waitForReactHydration(page, '[data-testid="keep-awake-toggle"]');

      const toggle = page.getByTestId('keep-awake-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');

      const box = await toggle.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { __wakeLockTest?: { requests: string[] } }).__wakeLockTest
                ?.requests.length ?? 0,
          ),
        )
        .toBe(1);

      expect(await page.evaluate(() => window.localStorage.getItem('sgi_keep_awake'))).toBe('1');

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { __wakeLockTest?: { sentinels: unknown[] } }).__wakeLockTest
                ?.sentinels.length ?? 0,
          ),
        )
        .toBe(1);

      // La navegación de "Volver" es client-side: desmonta el detalle y el hook
      // debe liberar el sentinel en su cleanup.
      await page.getByRole('button', { name: 'Volver', exact: true }).click();
      await expect(page).toHaveURL(/\/deposit\/orders$/);

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __wakeLockTest?: {
                    sentinels: Array<{ released: boolean; releaseCalls: number }>;
                  };
                }
              ).__wakeLockTest?.sentinels[0]?.released ?? false,
          ),
        )
        .toBe(true);

      expect(
        await page.evaluate(
          () =>
            (
              window as Window & {
                __wakeLockTest?: { sentinels: Array<{ releaseCalls: number }> };
              }
            ).__wakeLockTest?.sentinels[0]?.releaseCalls ?? 0,
        ),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

async function productIdByCode(page: Page, code: string): Promise<string> {
  const response = await page.request.get(
    `/api/products?search=${encodeURIComponent(code)}&limit=20`,
  );
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as {
    products: Array<{ _id: string; code: string }>;
  };
  const product = payload.products.find((item) => item.code === code);

  if (!product) throw new Error(`No se encontró el producto E2E ${code}`);

  return product._id;
}

interface E2EOrderDetail {
  _id: string;
  version?: number;
  items: Array<{ _id: string; requestedQuantity: number }>;
}

/**
 * Alta por API para los escenarios que necesitan más de 5 líneas (el catálogo
 * E2E sólo tiene 3 productos, así que se repiten para forzar los filtros).
 */
async function createMobileErgonomicsOrder(
  page: Page,
  clientCode: string,
  lines: Array<{ productId: string; requestedQuantity: number }>,
): Promise<string> {
  const clientId = await clientIdByCode(page, clientCode);
  const creation = await page.request.post('/api/orders', {
    data: {
      clientId,
      items: lines,
      invoiceType: 'A',
      paymentCondition: 'contado',
      clientRequestId: `e2e-mobile-ergo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(creation.status()).toBe(200);

  const payload = (await creation.json()) as { order: { _id: string } };
  return payload.order._id;
}

/** Deja el pedido en facturación con todas las líneas controladas en depósito. */
async function advanceOrderToBilling(page: Page, orderId: string): Promise<void> {
  const detail = await page.request.get(`/api/orders/${orderId}`);
  expect(detail.status()).toBe(200);

  const { order } = (await detail.json()) as { order: E2EOrderDetail };
  const update = await page.request.put(`/api/orders/${orderId}`, {
    data: {
      version: order.version ?? 0,
      status: 'facturacion',
      items: order.items.map((item) => ({
        _id: item._id,
        requestedQuantity: item.requestedQuantity,
        verifiedQuantity: item.requestedQuantity,
        isPending: false,
      })),
    },
  });
  expect(update.status()).toBe(200);
}

test.describe('Fluidez móvil de pedidos a 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('steppers, filtro de pendientes y aprobación inmediata en depósito', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 2 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 1 },
      { productId: primaryId, requestedQuantity: 2 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 1 },
    ]);

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      // Precalienta la bandeja destino: la prueba de navegación mide el paso a
      // facturación, no la compilación inicial de la ruta.
      await page.goto('/deposit/orders');
      await page.goto(`/deposit/orders/${orderId}`);

      const filters = page.getByTestId('line-filter-bar');
      await expect(filters).toBeVisible();
      await expect(page.getByTestId('line-filter-all')).toHaveText('Todas (6)');
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (6)');

      const cards = page.getByTestId('deposit-item-card');
      await expect(cards).toHaveCount(6);

      const firstCard = cards.first();
      const quantity = firstCard.locator('input[inputmode="numeric"]');
      await expect(quantity).toHaveValue('2');

      // Atajos de 1 toque: "Sin stock" deja la línea pendiente con motivo
      // sugerido y "= Solicitado" la controla sin abrir el motivo.
      await expect(firstCard.getByTestId('deposit-quick-shortcuts')).toBeVisible();
      await firstCard.getByRole('button', { name: 'Sin stock (0)', exact: true }).click();
      await expect(quantity).toHaveValue('0');

      const pendingReason = firstCard.getByPlaceholder(
        'Se completa automáticamente si lo dejás vacío',
      );
      await expect(pendingReason).toBeFocused();
      await expect(pendingReason).toHaveValue('Sin stock en depósito');
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('6');

      await firstCard.getByRole('button', { name: '= Solicitado (2)', exact: true }).click();
      await expect(quantity).toHaveValue('2');
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('5');

      const plus = firstCard.getByRole('button', { name: /^Sumar una unidad/ });
      const minus = firstCard.getByRole('button', { name: /^Restar una unidad/ });
      const plusBox = await plus.boundingBox();
      const minusBox = await minus.boundingBox();
      expect(plusBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(plusBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(minusBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(minusBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      await plus.click();
      // El primer toque en "+" ya confirma el control: no hace falta tocar
      // "Marcar como Controlado" para que baje el contador de pendientes.
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('5');
      await plus.click();
      await expect(quantity).toHaveValue('4');
      await minus.click();
      await expect(quantity).toHaveValue('3');
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('5');
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (5)');

      // El autosave local sigue el cambio de los steppers.
      await expect
        .poll(() =>
          page.evaluate((id) => {
            for (const key of Object.keys(window.localStorage)) {
              if (!key.startsWith('sgi_picking_autosave:')) continue;
              const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as {
                orderId?: string;
                items?: Record<string, { verifiedQty?: number }>;
              } | null;
              if (parsed?.orderId !== id) continue;
              return Object.values(parsed.items ?? {}).map((item) => item.verifiedQty);
            }
            return [];
          }, orderId),
        )
        .toContain(3);

      await page.getByTestId('line-filter-pending').click();
      await expect(cards).toHaveCount(5);

      const lineSearch = page.getByTestId('line-filter-search');
      await lineSearch.fill(E2E_PRODUCTS.otherBrand.code);
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toContainText(E2E_PRODUCTS.otherBrand.code);
      await page.getByRole('button', { name: 'Limpiar búsqueda de líneas' }).click();
      await expect(cards).toHaveCount(5);

      await page.getByTestId('picking-bulk-button').click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Marcar todo', exact: true })
        .click();
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('0');

      const approveResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'PUT',
      );
      await page
        .getByTestId('deposit-action-bar')
        .getByRole('button', { name: 'Aprobar', exact: true })
        .click();

      expect((await approveResponse).status()).toBe(200);
      const respondedAt = Date.now();
      await page.waitForURL(/\/deposit\/orders$/, { timeout: 1400 });
      expect(Date.now() - respondedAt).toBeLessThan(1400);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('agregar producto con +6 en una hoja móvil deja la línea controlada con miniatura', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const secondaryId = await productIdByCode(page, E2E_PRODUCTS.secondary.code);

    // El pedido arranca sin el producto primario (el único con imagen E2E).
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: secondaryId, requestedQuantity: 2 },
    ]);

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${orderId}`);

      await page.getByRole('button', { name: 'Agregar Producto' }).click();
      const dialog = page.getByRole('dialog', { name: 'Agregar Producto al Pedido' });
      await expect(dialog).toBeVisible();

      const search = dialog.getByPlaceholder('Buscar por código o nombre...');
      await search.fill(E2E_PRODUCTS.primary.code);

      const clear = dialog.getByRole('button', { name: 'Limpiar búsqueda de productos' });
      await expect(clear).toBeVisible();
      const clearBox = await clear.boundingBox();
      expect(clearBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(clearBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await clear.click();
      await expect(search).toHaveValue('');
      await search.fill(E2E_PRODUCTS.primary.code);

      const quantity = dialog.getByRole('spinbutton', { name: 'Cantidad a agregar' });
      await expect(quantity).toHaveValue('1');
      await dialog.getByRole('button', { name: '+6', exact: true }).click();
      await expect(quantity).toHaveValue('7');

      // La hoja móvil muestra la miniatura del producto y permite agregar en un toque.
      await expect(dialog.getByRole('img', { name: E2E_PRODUCTS.primary.name })).toBeVisible();
      await dialog.getByRole('button', { name: new RegExp(E2E_PRODUCTS.primary.code) }).click();

      await expect(dialog).toBeHidden();
      await expect(
        page.getByText(`Se agregaron 7 u. de ${E2E_PRODUCTS.primary.name}`),
      ).toBeVisible();

      const card = page
        .getByTestId('deposit-item-card')
        .filter({ hasText: E2E_PRODUCTS.primary.code });
      await expect(card).toHaveCount(1);
      await expect(card.locator('input[inputmode="numeric"]')).toHaveValue('7');
      await expect(card.getByRole('button', { name: '✓ Controlado', exact: true })).toBeVisible();
      await expect(card.getByRole('img', { name: E2E_PRODUCTS.primary.name })).toBeVisible();
      // La línea nueva ya está controlada: sólo queda pendiente la original.
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('1');
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('filtro por marca en el pedido y badge de producto ya cargado al agregar', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    // 4 líneas de E2E Laboratorio y 2 de E2E Segunda Marca para que aparezcan
    // los chips de marca y el pedido tenga más de 5 líneas.
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 2 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: primaryId, requestedQuantity: 2 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 4 },
      { productId: otherBrandId, requestedQuantity: 1 },
    ]);

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${orderId}`);

      const brandFilters = page.getByTestId('line-brand-filters');
      await expect(brandFilters).toBeVisible();
      await expect(
        brandFilters.getByRole('button', { name: `${E2E_SECONDARY_BRAND.name} (2)` }),
      ).toBeVisible();

      await brandFilters.getByRole('button', { name: `${E2E_SECONDARY_BRAND.name} (2)` }).click();
      await expect(
        brandFilters.getByRole('button', { name: `${E2E_SECONDARY_BRAND.name} (2)` }),
      ).toHaveAttribute('aria-pressed', 'true');

      const cards = page.getByTestId('deposit-item-card');
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toContainText(E2E_PRODUCTS.otherBrand.code);

      // El filtro de marca convive con el chip de estado.
      await page.getByTestId('line-filter-pending').click();
      await expect(cards).toHaveCount(2);

      await page.getByRole('button', { name: 'Agregar Producto' }).click();
      const dialog = page.getByRole('dialog', { name: 'Agregar Producto al Pedido' });
      await expect(dialog).toBeVisible();

      const addBrandFilters = dialog.getByTestId('add-product-brand-filters');
      await expect(addBrandFilters).toBeVisible();
      await addBrandFilters.getByRole('button', { name: E2E_SECONDARY_BRAND.name }).click();
      await expect(
        addBrandFilters.getByRole('button', { name: E2E_SECONDARY_BRAND.name }),
      ).toHaveAttribute('aria-pressed', 'true');

      const search = dialog.getByPlaceholder('Buscar por código o nombre...');
      await search.fill(E2E_PRODUCTS.otherBrand.code);

      const productRow = dialog
        .getByRole('button', { name: new RegExp(E2E_PRODUCTS.otherBrand.code) })
        .first();
      await expect(productRow).toBeVisible();
      await expect(productRow.getByTestId('add-product-in-order-badge')).toHaveText(
        'En el pedido: 4 u.',
      );
      await expect(productRow.getByText('+ Sumar', { exact: true })).toBeVisible();
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('comentario sin redirección, post-control optimista y facturado en móvil', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 2 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 1 },
      { productId: primaryId, requestedQuantity: 2 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 1 },
    ]);

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await advanceOrderToBilling(page, orderId);

      await loginThroughUi(page, E2E_USERS.billing);
      await page.goto('/billing/orders');
      await page.goto(`/billing/orders/${orderId}`);
      // WebKit puede tardar en hidratar el textarea controlado: esperar la red
      // estable evita que el primer render pise el `fill`.
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();

      await expect(page.getByTestId('line-filter-bar')).toBeVisible();
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (6)');
      await expect(page.getByTestId('line-filter-difference')).toHaveText(
        'Con diferencia / Faltantes (0)',
      );

      const commentText = 'Comentario E2E sin salir del pedido';
      const commentBox = page.getByPlaceholder('Escribe un comentario u observación...');
      const saveComment = page.getByRole('button', { name: 'Guardar Comentario' });

      // En WebKit la hidratación puede resolver después del primer `fill`: el
      // valor queda en el DOM pero el estado controlado sigue vacío y el botón
      // deshabilitado. Se espera el handler de React antes de escribir.
      await waitForReactHydration(
        page,
        'textarea[placeholder="Escribe un comentario u observación..."]',
      );
      await expect(async () => {
        await commentBox.fill(commentText);
        await expect(commentBox).toHaveValue(commentText);
        await expect(saveComment).toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });

      const commentResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'PUT',
      );
      await saveComment.click();

      expect((await commentResponse).status()).toBe(200);
      // Guardar el comentario actualiza la versión local, pero no abandona el
      // detalle del pedido.
      await expect(page).toHaveURL(new RegExp(`/billing/orders/${orderId}$`));
      await expect(page.getByText(commentText, { exact: true })).toBeVisible();
      await expect(commentBox).toHaveValue('');

      const detailAfterComment = await page.request.get(`/api/orders/${orderId}`);
      expect(detailAfterComment.status()).toBe(200);
      const afterComment = (await detailAfterComment.json()) as {
        order: { comments?: Array<{ text: string }> };
      };
      expect(afterComment.order.comments?.some((comment) => comment.text === commentText)).toBe(
        true,
      );

      const patchStatuses: number[] = [];
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.endsWith('/post-control') && response.request().method() === 'PATCH') {
          patchStatuses.push(response.status());
        }
      });

      // Retrasa cada PATCH para que los seis toques se solapen: la cola debe
      // serializarlos con la versión devuelta por el lote anterior.
      await page.route('**/api/orders/*/post-control', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await route.continue();
      });

      const cards = page.getByTestId('billing-item-card');
      await expect(cards).toHaveCount(6);

      for (let index = 0; index < 6; index += 1) {
        await cards
          .nth(index)
          .getByRole('group', { name: 'Control post-factura de la línea' })
          .getByRole('button', { name: 'OK', exact: true })
          .click();
      }

      // La UI no espera a la red: las seis líneas ya figuran controladas.
      await expect(page.getByTestId('billing-mobile-pending-count')).toHaveText('0');
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (0)');

      const finalAction = page.getByTestId('billing-final-action');
      await expect(finalAction).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByTestId('post-control-saving')).toHaveCount(0);

      await expect.poll(() => patchStatuses.length).toBeGreaterThan(0);
      expect(patchStatuses.every((status) => status === 200)).toBe(true);
      expect(patchStatuses).not.toContain(409);

      const persistedResponse = await page.request.get(`/api/orders/${orderId}`);
      expect(persistedResponse.status()).toBe(200);
      const persisted = (await persistedResponse.json()) as {
        order: { items: Array<{ postControl?: string }> };
      };
      expect(persisted.order.items.every((item) => item.postControl === 'ok')).toBe(true);

      const markInvoiced = page.getByTestId('billing-mark-invoiced');
      await expect(markInvoiced).toBeVisible();
      await expect(markInvoiced).toBeEnabled();

      const statusResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'PUT',
      );
      await markInvoiced.click();

      expect((await statusResponse).status()).toBe(200);
      const respondedAt = Date.now();
      await page.waitForURL(/\/billing\/orders$/, { timeout: 1400 });
      expect(Date.now() - respondedAt).toBeLessThan(1400);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('facturación no marca faltante una línea al 100% y copia los datos', async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      const state: { copied: string[] } = { copied: [] };
      (window as Window & { __billingCopyTest?: typeof state }).__billingCopyTest = state;

      const fakeClipboard = {
        writeText: async (text: string) => {
          state.copied.push(text);
        },
      };

      const define = (target: object, property: string, value: unknown): boolean => {
        try {
          Object.defineProperty(target, property, { configurable: true, value });
          return true;
        } catch {
          return false;
        }
      };

      if (!define(navigator, 'clipboard', fakeClipboard)) {
        define(Navigator.prototype, 'clipboard', fakeClipboard);
      }
    });

    await loginThroughUi(page, E2E_USERS.seller);
    const [clientId, productId] = await Promise.all([
      clientIdByCode(page, E2E_CLIENTS.mobileControl.code),
      productIdByCode(page, E2E_PRODUCTS.primary.code),
    ]);

    const creation = await page.request.post('/api/orders', {
      data: {
        clientId,
        items: [{ productId, requestedQuantity: 2, customDiscount: 100 }],
        invoiceType: 'A',
        paymentCondition: 'contado',
        clientRequestId: `e2e-billing-full-discount-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(creation.status()).toBe(200);
    const orderId = ((await creation.json()) as { order: { _id: string } }).order._id;

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await advanceOrderToBilling(page, orderId);

      await loginThroughUi(page, E2E_USERS.billing);
      await page.goto(`/billing/orders/${orderId}`);
      await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();

      // Modo manos libres disponible durante el control post-factura.
      const keepAwakeToggle = page.getByTestId('keep-awake-toggle');
      await expect(keepAwakeToggle).toBeVisible();
      const keepAwakeBox = await keepAwakeToggle.boundingBox();
      expect(keepAwakeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      // La fila de acciones de la cabecera envuelve sin desbordar en 360 px.
      await page.setViewportSize({ width: 360, height: 800 });
      await expectNoHorizontalOverflow(page, 'cabecera de facturación @360px');
      await page.setViewportSize({ width: 390, height: 844 });

      const card = page
        .getByTestId('billing-item-card')
        .filter({ hasText: E2E_PRODUCTS.primary.code });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('100%');
      await expect(card.getByRole('img', { name: E2E_PRODUCTS.primary.name })).toBeVisible();
      await expect(card).not.toContainText(/sin controlar\/faltante/i);
      await expect(card).not.toContainText('No verificado en depósito');
      await expect(page.getByText(/sin controlar\/faltante/i)).toHaveCount(0);

      await page.getByTestId('billing-copy-data').click();
      await expect(page.getByText('Datos estructurados copiados al portapapeles.')).toBeVisible();

      const copied = await page.evaluate(
        () =>
          (window as Window & { __billingCopyTest?: { copied: string[] } }).__billingCopyTest
            ?.copied ?? [],
      );
      expect(copied).toHaveLength(1);
      expect(copied[0]).toContain(E2E_PRODUCTS.primary.code);
      expect(copied[0]).not.toContain('Sin controlar/faltante');
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Filtro de pendientes con línea activa @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('dos toques en - conservan la tarjeta activa y los contadores al día', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    // Más de 5 líneas para que se monten los chips. La primera línea usa el
    // único producto primario, así se puede identificar sin ambigüedad.
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 4 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 1 },
      { productId: secondaryId, requestedQuantity: 1 },
      { productId: otherBrandId, requestedQuantity: 1 },
      { productId: secondaryId, requestedQuantity: 1 },
    ]);

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${orderId}`);

      const filters = page.getByTestId('line-filter-bar');
      await expect(filters).toBeVisible();
      await page.getByTestId('line-filter-pending').click();
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (6)');

      const cards = page.getByTestId('deposit-item-card');
      await expect(cards).toHaveCount(6);

      const firstCard = cards
        .filter({ hasText: E2E_PRODUCTS.primary.code })
        .filter({ hasText: E2E_PRODUCTS.primary.name });
      await expect(firstCard).toHaveCount(1);
      const quantity = firstCard.locator('input[inputmode="numeric"]');
      await expect(quantity).toHaveValue('4');
      const minus = firstCard.getByRole('button', { name: /^Restar una unidad/ });

      // El primer toque controla la línea y la sacaría de "Pendientes". El pin
      // debe mantenerla visible y, aun así, actualizar el contador del chip.
      await expect(async () => {
        await minus.click();
        await expect(quantity).toHaveValue('3', { timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await expect(firstCard).toHaveCount(1);
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (5)');

      // El segundo toque consecutivo sigue sobre la misma tarjeta.
      await minus.click();
      await expect(quantity).toHaveValue('2');
      await expect(firstCard).toHaveCount(1);
      await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (5)');

      // Al tocar otra tarjeta el pin pasa a esa línea y la primera deja de
      // mostrarse porque ya está controlada.
      const secondCard = cards.nth(1);
      await expect(secondCard).toContainText(E2E_PRODUCTS.secondary.code);
      await expect(async () => {
        await secondCard.getByRole('button', { name: /^Sumar una unidad/ }).click();
        await expect(page.getByTestId('line-filter-pending')).toHaveText('Pendientes (4)', {
          timeout: 1_000,
        });
      }).toPass({ timeout: 15_000 });
      await expect(firstCard).toHaveCount(0);

      // Cambiar de chip libera el pin y vuelve a mostrar todas las líneas.
      await page.getByTestId('line-filter-all').click();
      await expect(cards).toHaveCount(6);
      await expect(firstCard).toHaveCount(1);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('la barra de filtros queda sticky al recorrer un pedido largo en depósito', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    // 12 líneas: la barra se monta (>5) y el scroll tiene suficiente recorrido
    // para comprobar que queda pegada debajo del top bar.
    const productIds = [primaryId, secondaryId, otherBrandId];
    const orderId = await createMobileErgonomicsOrder(
      page,
      E2E_CLIENTS.mobileControl.code,
      Array.from({ length: 12 }, (_, index) => ({
        productId: productIds[index % productIds.length],
        requestedQuantity: 1 + (index % 2),
      })),
    );

    try {
      await loginThroughUi(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${orderId}`);

      const filters = page.getByTestId('line-filter-bar');
      await expect(filters).toBeVisible();

      const cards = page.getByTestId('deposit-item-card');
      await expect(cards).toHaveCount(12);

      // La altura se mantiene compacta: chips de estado, chips de marca y
      // buscador (44 px por fila) más el padding y el borde.
      const initialBox = await filters.boundingBox();
      expect(initialBox?.height ?? 0).toBeLessThanOrEqual(160);

      for (const testId of ['line-filter-all', 'line-filter-search'] as const) {
        const box = await page.getByTestId(testId).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      await expect
        .poll(() => filters.evaluate((element) => getComputedStyle(element).position))
        .toBe('sticky');
      await expect
        .poll(() =>
          cards.first().evaluate((element) => getComputedStyle(element).contentVisibility),
        )
        .toBe('auto');

      // Baja hasta la última tarjeta y verifica que la barra sigue visible
      // justo debajo del top bar (64 px), sin perderse con el scroll.
      await cards.last().scrollIntoViewIfNeeded();
      const stickyBox = await filters.boundingBox();
      expect(stickyBox?.y ?? -1).toBeGreaterThanOrEqual(60);
      expect(stickyBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(68);

      // La barra sigue siendo interactiva en esa posición.
      await page.getByTestId('line-filter-pending').click();
      await expect(page.getByTestId('line-filter-pending')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Picking y post-control a 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('control rápido, deshacer y barras fijas de una mano', async ({ page, request }) => {
    const client = E2E_CLIENTS.mobileControl;

    await loginThroughUi(page, E2E_USERS.seller);
    const clientId = await clientIdByCode(page, client.code);
    const [primaryId, secondaryId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
    ]);

    const creation = await page.request.post('/api/orders', {
      data: {
        clientId,
        items: [
          { productId: primaryId, requestedQuantity: 3 },
          { productId: secondaryId, requestedQuantity: 2 },
        ],
        invoiceType: 'A',
        paymentCondition: 'contado',
        clientRequestId: `e2e-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(creation.status()).toBe(200);
    const { order } = (await creation.json()) as { order: { _id: string } };

    try {
      // Depósito: la barra fija muestra pendientes y la acción final.
      await loginThroughUi(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${order._id}`);
      await expect(
        page.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
      ).toBeVisible();

      const depositBar = page.getByTestId('deposit-action-bar');
      await expect(depositBar).toBeVisible();
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('2');

      // Autosave local: un control sin guardar sobrevive a la recarga y se
      // ofrece restaurarlo sólo para la misma versión del pedido.
      await page
        .getByRole('button', { name: 'Marcar como Controlado', exact: true })
        .first()
        .click();
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('1');
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(window.localStorage).some((key) => key.startsWith('sgi_picking_autosave:')),
          ),
        )
        .toBe(true);

      await page.reload();
      await expect(page.getByTestId('picking-restore-banner')).toBeVisible();
      await page.getByTestId('picking-restore-button').click();
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('1');

      // Control rápido: confirma, controla todo y se puede deshacer.
      await page.getByTestId('picking-bulk-button').click();
      const quickDialog = page.getByRole('dialog');
      await expect(
        quickDialog.getByRole('heading', { name: 'Marcar todo con cantidad pedida' }),
      ).toBeVisible();
      await quickDialog.getByRole('button', { name: 'Marcar todo', exact: true }).click();

      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('0');
      await expect(page.getByTestId('picking-undo-button')).toBeVisible();

      await page.getByTestId('picking-undo-button').click();
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('1');

      await page.getByTestId('picking-bulk-button').click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Marcar todo', exact: true })
        .click();
      await expect(page.getByTestId('deposit-mobile-pending-count')).toHaveText('0');

      const approveResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${order._id}` &&
          response.request().method() === 'PUT',
      );
      await depositBar.getByRole('button', { name: 'Aprobar', exact: true }).click();
      expect((await approveResponse).status()).toBe(200);
      await expect(page).toHaveURL(/\/deposit\/orders$/);

      // Facturación: "Marcar todas OK" con deshacer y entrega bloqueada.
      await loginThroughUi(page, E2E_USERS.billing);
      await page.goto(`/billing/orders/${order._id}`);
      await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();

      const billingBar = page.getByTestId('billing-action-bar');
      await expect(billingBar).toBeVisible();
      await expect(page.getByTestId('billing-mobile-pending-count')).toHaveText('2');

      const finalAction = page.getByTestId('billing-final-action');
      await expect(finalAction).toHaveText('Confirmar Despacho');
      await expect(finalAction).toBeDisabled();

      await page.getByTestId('billing-mark-all-ok').click();
      const bulkDialog = page.getByRole('dialog');
      await expect(bulkDialog.getByRole('heading', { name: 'Marcar todas OK' })).toBeVisible();
      await bulkDialog.getByRole('button', { name: 'Marcar todas OK', exact: true }).click();

      await expect(page.getByTestId('billing-mobile-pending-count')).toHaveText('0');
      await expect(finalAction).toBeEnabled();
      await expect(page.getByTestId('billing-undo-control')).toBeVisible();

      await page.getByTestId('billing-undo-control').click();
      await expect(page.getByTestId('billing-mobile-pending-count')).toHaveText('2');
      await expect(finalAction).toBeDisabled();

      await page.getByTestId('billing-mark-all-ok').click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Marcar todas OK', exact: true })
        .click();
      await expect(page.getByTestId('billing-mobile-pending-count')).toHaveText('0');

      const deliverResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${order._id}` &&
          response.request().method() === 'PUT',
      );
      await finalAction.click();
      expect((await deliverResponse).status()).toBe(200);
      await expect(page).toHaveURL(/\/billing\/orders$/);
    } finally {
      await deleteOrderAsAdmin(request, order._id);
    }
  });
});

test.describe('Repetir y editar borradores @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('repite un pedido en el carrito, suma un producto y edita el borrador', async ({
    page,
    request,
  }) => {
    const client = E2E_CLIENTS.mobileControl;
    const primary = E2E_PRODUCTS.primary;
    const secondary = E2E_PRODUCTS.secondary;

    await loginThroughUi(page, E2E_USERS.seller);

    const clientId = await clientIdByCode(page, client.code);
    const primaryId = await productIdByCode(page, primary.code);

    const originalCreation = await page.request.post('/api/orders', {
      data: {
        clientId,
        items: [{ productId: primaryId, requestedQuantity: 2 }],
        invoiceType: 'A',
        paymentCondition: 'contado',
        clientRequestId: `e2e-repeat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(originalCreation.status()).toBe(200);
    const originalId = ((await originalCreation.json()) as { order: { _id: string } }).order._id;

    let repeatedId: string | null = null;

    try {
      // Repetir desde el detalle de "Mis pedidos": el pedido se carga en el
      // formulario en lugar de crear un borrador nuevo por API.
      await page.goto(`/orders/${originalId}`);
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();

      await page.getByRole('button', { name: 'Repetir pedido' }).click();
      // La precarga viaja por `?fromOrder=`, pero al aplicarse el alta limpia
      // ese parámetro transitorio para que una recarga restaure el borrador.
      await expect(page).toHaveURL(/\/orders\/new$/);
      await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

      // Cliente, línea, factura y condición de pago precargados. Con los datos
      // comerciales completos la tarjeta móvil se pliega en chips; el botón
      // reabre los selects para verificar los valores precargados.
      await expect(page.getByTestId('selected-products-filter')).toHaveText('Seleccionados (1)');
      await expect(page.getByRole('heading', { name: primary.name, exact: true })).toBeVisible();
      await expect(
        page
          .locator('.cv-product-card')
          .filter({ hasText: primary.code })
          .getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }),
      ).toHaveValue('2');

      const commercialSummary = page.getByTestId('mobile-commercial-summary');
      await expect(commercialSummary).toContainText('Factura A');
      await expect(commercialSummary).toContainText('Contado');
      await commercialSummary
        .getByRole('button', { name: 'Editar condición / descuentos' })
        .click();
      await expect(page.getByLabel('Tipo de factura').filter({ visible: true })).toHaveValue('A');
      await expect(page.getByLabel('Condición de pago').filter({ visible: true })).toHaveValue(
        'contado',
      );
      await commercialSummary
        .getByRole('button', { name: 'Ocultar condición / descuentos' })
        .click();

      // Sumar un producto antes de guardar.
      const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
      await productSearch.fill(secondary.code);
      await expect(page.getByRole('heading', { name: secondary.name, exact: true })).toBeVisible();

      const secondaryCard = page.locator('.cv-product-card').filter({ hasText: secondary.code });
      const secondaryQuantity = secondaryCard.getByRole('spinbutton', {
        name: /^Cantidad en el catálogo de/,
      });
      await secondaryQuantity.fill('1');
      await expect(secondaryQuantity).toHaveValue('1');

      // Guardar desde el resumen móvil y capturar el pedido creado.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
      await page.getByTestId('mobile-cart-button').click();

      const summary = page.getByRole('dialog');
      await expect(summary.getByTestId('selected-order-item')).toHaveCount(2);
      await expect(
        summary.getByTestId('selected-order-item').filter({ hasText: primary.code }),
      ).toContainText(primary.name);
      await expect(
        summary.getByTestId('selected-order-item').filter({ hasText: secondary.code }),
      ).toContainText(secondary.name);

      const createResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          response.request().method() === 'POST',
      );
      await summary.getByRole('button', { name: 'Guardar Pedido (Borrador)' }).click();

      const createdResponse = await createResponse;
      expect(createdResponse.status()).toBe(200);
      repeatedId = ((await createdResponse.json()) as { order: { _id: string } }).order._id;

      await page.waitForURL(new RegExp(`/orders/${repeatedId}$`));
      await expect(page.getByText('¡Pedido creado en estado Borrador exitosamente!')).toBeVisible();
      const continuityActions = page.locator(
        '[data-testid="vendor-order-continuity-actions"]:visible',
      );
      await expect(continuityActions).toHaveCount(1);
      await expect(continuityActions.getByTestId('vendor-order-new-order')).toBeVisible();
      await expect(
        continuityActions.getByRole('button', { name: 'Compartir resumen del pedido' }),
      ).toBeVisible();

      const repeatedDetail = await page.request.get(`/api/orders/${repeatedId}`);
      expect(repeatedDetail.status()).toBe(200);
      const repeatedOrder = (await repeatedDetail.json()) as {
        order: { status: string; items: Array<{ requestedQuantity: number }> };
      };
      expect(repeatedOrder.order.status).toBe('borrador');
      expect(repeatedOrder.order.items.map((item) => item.requestedQuantity).sort()).toEqual([
        1, 2,
      ]);

      // Editar el borrador propia desde el detalle.
      await page.goto(`/orders/${repeatedId}`);
      await expect(page.getByRole('button', { name: 'Editar borrador' })).toBeVisible();
      await page.getByRole('button', { name: 'Editar borrador' }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${repeatedId}/edit$`));
      await expect(page.getByRole('heading', { name: 'Editar Pedido' })).toBeVisible();
      await expect(page.getByTestId('selected-products-filter')).toHaveText('Seleccionados (2)');

      // Ajustar datos comerciales y cantidades en el mismo formulario. La
      // tarjeta vuelve a estar plegada tras la precarga: se reabre para editar.
      const editCommercialSummary = page.getByTestId('mobile-commercial-summary');
      await editCommercialSummary
        .getByRole('button', { name: 'Editar condición / descuentos' })
        .click();
      await page.getByLabel('Tipo de factura').filter({ visible: true }).selectOption('B');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
      await page.getByTestId('mobile-cart-button').click();

      const editSummary = page.getByRole('dialog');
      await expect(
        editSummary.getByTestId('selected-order-item').filter({ hasText: secondary.code }),
      ).toContainText(secondary.name);
      const primaryLine = editSummary
        .getByTestId('selected-order-item')
        .filter({ hasText: primary.code });
      const primaryQuantity = primaryLine.getByRole('spinbutton', {
        name: `Cantidad en el pedido de ${primary.name}`,
      });
      await expect(primaryQuantity).toHaveValue('2');
      await primaryLine
        .getByRole('button', { name: `Sumar una unidad del pedido para ${primary.name}` })
        .click();
      await expect(primaryQuantity).toHaveValue('3');

      const updateResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${repeatedId}` &&
          response.request().method() === 'PUT',
      );
      await editSummary.getByRole('button', { name: 'Guardar Cambios' }).click();

      const savedResponse = await updateResponse;
      expect(savedResponse.status()).toBe(200);
      await page.waitForURL(new RegExp(`/orders/${repeatedId}$`));

      const editedDetail = await page.request.get(`/api/orders/${repeatedId}`);
      expect(editedDetail.status()).toBe(200);
      const editedOrder = (await editedDetail.json()) as {
        order: {
          status: string;
          invoiceType?: string;
          items: Array<{ requestedQuantity: number }>;
        };
      };
      expect(editedOrder.order.status).toBe('borrador');
      expect(editedOrder.order.invoiceType).toBe('B');
      expect(editedOrder.order.items.map((item) => item.requestedQuantity).sort()).toEqual([1, 3]);
    } finally {
      if (repeatedId) await deleteOrderAsAdmin(request, repeatedId);
      await deleteOrderAsAdmin(request, originalId);
    }
  });
});

test.describe('Comentarios del vendedor en el detalle @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('responde con un chip y guarda sin salir del pedido', async ({ page, request }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const primaryId = await productIdByCode(page, E2E_PRODUCTS.primary.code);
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 2 },
    ]);

    try {
      await page.goto(`/orders/${orderId}`);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: /Comentarios y Observaciones/ }),
      ).toBeVisible();

      const quickReplies = page.getByTestId('comment-quick-replies');
      await expect(quickReplies).toBeVisible();
      await expectMobileErgonomics(page, 'detalle del vendedor con comentarios');

      const commentBox = page.getByPlaceholder('Escribe un comentario u observación...');
      const saveComment = page.getByRole('button', { name: 'Guardar Comentario' });

      // Un toque en el chip inserta la respuesta rápida en el campo.
      await quickReplies.getByRole('button', { name: 'Urgente', exact: true }).click();
      await expect(commentBox).toHaveValue('Urgente');
      await expect(saveComment).toBeEnabled();

      const commentResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'PUT',
      );
      await saveComment.click();

      expect((await commentResponse).status()).toBe(200);
      // Guardar actualiza la versión local y deja el comentario listado, sin
      // abandonar el detalle ni perder el formulario.
      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
      await expect(page.getByTestId('order-comment').filter({ hasText: 'Urgente' })).toBeVisible();
      await expect(commentBox).toHaveValue('');

      const detailAfterComment = await page.request.get(`/api/orders/${orderId}`);
      expect(detailAfterComment.status()).toBe(200);
      const afterComment = (await detailAfterComment.json()) as {
        order: { comments?: Array<{ text: string; role?: string }> };
      };
      expect(
        afterComment.order.comments?.some(
          (comment) => comment.text === 'Urgente' && comment.role === 'vendedor',
        ),
      ).toBe(true);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Faltantes y archivado en el detalle del vendedor @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('muestra el motivo del faltante parcial, filtra y archiva/desarchiva', async ({
    page,
    request,
  }) => {
    await loginThroughUi(page, E2E_USERS.seller);
    const [primaryId, secondaryId, otherBrandId] = await Promise.all([
      productIdByCode(page, E2E_PRODUCTS.primary.code),
      productIdByCode(page, E2E_PRODUCTS.secondary.code),
      productIdByCode(page, E2E_PRODUCTS.otherBrand.code),
    ]);

    // Seis líneas fuerzan la barra de filtros del detalle del vendedor.
    const orderId = await createMobileErgonomicsOrder(page, E2E_CLIENTS.mobileControl.code, [
      { productId: primaryId, requestedQuantity: 4 },
      { productId: secondaryId, requestedQuantity: 4 },
      { productId: otherBrandId, requestedQuantity: 4 },
      { productId: primaryId, requestedQuantity: 4 },
      { productId: secondaryId, requestedQuantity: 4 },
      { productId: otherBrandId, requestedQuantity: 4 },
    ]);

    try {
      // Depósito deja una línea con faltante parcial (2 de 4) y el resto OK.
      await loginThroughUi(page, E2E_USERS.deposit);
      const detailResponse = await page.request.get(`/api/orders/${orderId}`);
      expect(detailResponse.status()).toBe(200);
      const { order } = (await detailResponse.json()) as { order: E2EOrderDetail };

      const updateResponse = await page.request.put(`/api/orders/${orderId}`, {
        data: {
          version: order.version ?? 0,
          status: 'paralizado',
          items: order.items.map((item, index) => ({
            _id: item._id,
            requestedQuantity: item.requestedQuantity,
            verifiedQuantity: index === 0 ? 2 : item.requestedQuantity,
            isPending: false,
            ...(index === 0 ? { pendingReason: 'Faltante: 2 de 4 controlados' } : {}),
          })),
        },
      });
      expect(updateResponse.status()).toBe(200);

      await loginThroughUi(page, E2E_USERS.seller);
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();
      await page.waitForLoadState('networkidle');

      // La alerta resume el faltante y el badge conserva la cantidad real y el
      // motivo escrito por depósito.
      const summary = page.getByTestId('vendor-order-shortage-summary');
      await expect(summary).toBeVisible();
      await expect(summary).toContainText('Pedido paralizado');
      await expect(summary).toContainText('1 línea con faltante');

      // Atajo de respuesta: lleva al panel de comentarios y deja el campo
      // enfocado para confirmar una respuesta rápida sin scrollear a mano.
      const replyShortcut = summary.getByTestId('vendor-order-reply-shortcut');
      await expect(replyShortcut).toBeVisible();
      const commentBox = page.getByTestId('comment-textarea');
      await replyShortcut.click();
      await expect(commentBox).toBeFocused();
      await page
        .getByTestId('comment-quick-replies')
        .getByRole('button', { name: 'Enviar lo disponible', exact: true })
        .click();
      await expect(commentBox).toHaveValue('Enviar lo disponible');

      const cards = page.getByTestId('vendor-order-item-card');
      await expect(cards).toHaveCount(6);

      // La tarjeta móvil conserva la miniatura del producto poblado.
      await expect(
        cards
          .filter({ hasText: E2E_PRODUCTS.primary.code })
          .first()
          .getByRole('img', { name: E2E_PRODUCTS.primary.name }),
      ).toBeVisible();

      // En 360 px los dos atajos del banner envuelven sin desbordar y
      // mantienen 44 px de alto.
      await page.setViewportSize({ width: 360, height: 800 });
      await expectNoHorizontalOverflow(page, 'banner de faltantes @360px');
      const [replyBox, filterBox] = await Promise.all([
        replyShortcut.boundingBox(),
        page.getByTestId('vendor-order-shortage-filter').boundingBox(),
      ]);
      expect(replyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(filterBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.setViewportSize({ width: 390, height: 844 });
      const partialCard = cards.filter({ hasText: 'Faltante parcial (2 de 4)' });
      await expect(partialCard).toHaveCount(1);
      await expect(partialCard).toContainText('Faltante: 2 de 4 controlados');

      // El filtro de diferencia deja sólo la línea afectada.
      await expect(page.getByTestId('line-filter-bar')).toBeVisible();
      await expect(page.getByTestId('line-filter-difference')).toContainText(
        'Con diferencia / Faltantes (1)',
      );
      await page.getByTestId('vendor-order-shortage-filter').click();
      await expect(page.getByTestId('line-filter-difference')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText('Faltante parcial (2 de 4)');
      await expectNoHorizontalOverflow(page, 'detalle del vendedor filtrado @390px');

      // Archivar desde el detalle pide confirmación, actualiza el badge local
      // y persiste el estado en la API.
      await page.getByTestId('vendor-order-archive').click();
      const archiveDialog = page.getByRole('dialog', { name: 'Archivar pedido' });
      await expect(archiveDialog).toBeVisible();

      const archiveResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'PUT',
      );
      await archiveDialog.getByRole('button', { name: 'Archivar', exact: true }).click();
      expect((await archiveResponse).status()).toBe(200);

      await expect(page.getByTestId('vendor-order-archive')).toContainText('Desarchivar');
      await expect(page.getByText('Pedido archivado', { exact: true })).toBeVisible();
      const archivedDetail = await page.request.get(`/api/orders/${orderId}`);
      expect(archivedDetail.status()).toBe(200);
      expect(
        ((await archivedDetail.json()) as { order: { archived?: boolean } }).order.archived,
      ).toBe(true);

      // Desarchivar vuelve a dejar el pedido activo sin salir del detalle.
      await page.getByTestId('vendor-order-archive').click();
      const unarchiveDialog = page.getByRole('dialog', { name: 'Desarchivar pedido' });
      await expect(unarchiveDialog).toBeVisible();

      const unarchiveResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/orders/${orderId}` &&
          response.request().method() === 'PUT',
      );
      await unarchiveDialog.getByRole('button', { name: 'Desarchivar', exact: true }).click();
      expect((await unarchiveResponse).status()).toBe(200);

      await expect(page.getByTestId('vendor-order-archive')).toContainText('Archivar');
      await expect(page.getByText('Pedido archivado', { exact: true })).toHaveCount(0);
      const restoredDetail = await page.request.get(`/api/orders/${orderId}`);
      expect(restoredDetail.status()).toBe(200);
      expect(
        ((await restoredDetail.json()) as { order: { archived?: boolean } }).order.archived,
      ).toBe(false);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});

test.describe('Atajos de cantidad y descuento compacto @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('suma +6/+12 y ajusta el descuento manual desde el chip', async ({ page }) => {
    const product = E2E_PRODUCTS.primary;

    await loginThroughUi(page, E2E_USERS.seller);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();
    // En WebKit la primera visita a la ruta puede compilar el bundle después
    // del HTML: esperar la red estable garantiza que el buscador ya hidrató.
    await page.waitForLoadState('networkidle');

    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    // En WebKit la hidratación puede resolver después del primer `fill`: se
    // reintenta hasta que React conserve el texto y dispare la búsqueda.
    await expect(async () => {
      await productSearch.fill(product.code);
      await expect(productSearch).toHaveValue(product.code);
    }).toPass({ timeout: 30_000 });

    const card = page.locator('.cv-product-card').filter({ hasText: product.code });
    await expect(card).toBeVisible();

    const quantity = card.getByRole('spinbutton');
    const plus6 = card.getByRole('button', { name: `Sumar 6 unidades de ${product.name}` });
    const plus12 = card.getByRole('button', { name: `Sumar 12 unidades de ${product.name}` });

    // Los atajos tienen área táctil cómoda para el pulgar.
    for (const button of [plus6, plus12]) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // En WebKit el primer toque puede llegar antes de que hidrate el catálogo
    // (ahora la primera página ya viene renderizada por el servidor). Se
    // reintenta hasta que React refleje la cantidad.
    await expect(async () => {
      await plus6.click();
      await expect(quantity).toHaveValue('6', { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    await expect(async () => {
      await plus12.click();
      await expect(quantity).toHaveValue('18', { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    // El descuento vigente se muestra compacto; el input sólo se despliega al
    // tocar "Ajustar" y queda enfocado para escribir sin un toque extra.
    const discountChip = card.getByTestId('catalog-discount-chip');
    await expect(discountChip).toBeVisible();
    await expect(discountChip).toContainText('· Ajustar');
    await discountChip.click();

    const discountInput = card.getByTestId('catalog-discount-input');
    await expect(discountInput).toBeVisible();
    await expect(discountInput).toBeFocused();
    await expect(card.getByTestId('catalog-discount-chip')).toHaveCount(0);

    await discountInput.fill('15');
    await expect(discountInput).toHaveValue('15');

    // El override manual llega al resumen del carrito.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
    await page.getByTestId('mobile-cart-button').click();

    const summary = page.getByRole('dialog');
    const line = summary.getByTestId('selected-order-item').filter({ hasText: product.code });
    const cartQuantity = line.getByRole('spinbutton', {
      name: `Cantidad en el pedido de ${product.name}`,
    });

    await expect(line).toContainText('Desc. 15%');
    await expect(cartQuantity).toHaveValue('18');

    // El atajo +6 del carrito también evita abrir el teclado numérico.
    await line.getByRole('button', { name: `Sumar 6 unidades de ${product.name}` }).click();
    await expect(cartQuantity).toHaveValue('24');

    // Al quitar el override vuelve el chip compacto y el input se repliega.
    await summary.getByRole('button', { name: 'Cerrar resumen del pedido' }).click();
    await card
      .getByRole('button', { name: `Volver al descuento de la marca para ${product.name}` })
      .click();
    await expect(card.getByTestId('catalog-discount-chip')).toBeVisible();
    await expect(card.getByTestId('catalog-discount-input')).toHaveCount(0);
  });
});

test.describe('Carrito editable en el resumen móvil @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('lista productos de dos marcas, edita cantidades, quita líneas y restaura el borrador', async ({
    page,
  }) => {
    const client = E2E_CLIENTS.mobileControl;
    const primary = E2E_PRODUCTS.primary;
    const otherBrand = E2E_PRODUCTS.otherBrand;

    await loginThroughUi(page, E2E_USERS.seller);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

    // Cliente por el modal móvil.
    await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
    const clientDialog = page.getByRole('dialog');
    await expect(clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' })).toBeVisible();
    await clientDialog
      .getByPlaceholder('Buscar por código, nombre o localidad...')
      .fill(client.code);
    await clientDialog
      .getByRole('button', { name: new RegExp(`${client.code} - ${client.name}`) })
      .click();
    await expect(clientDialog).toBeHidden();

    // Dos productos de marcas distintas.
    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');

    for (const product of [primary, otherBrand]) {
      await productSearch.fill(product.code);
      await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();

      const card = page.locator('.cv-product-card').filter({ hasText: product.code });
      const quantity = card.getByRole('spinbutton');
      await quantity.fill('2');
      await expect(quantity).toHaveValue('2');
    }

    await page.getByRole('button', { name: 'Limpiar búsqueda de productos' }).click();
    await expect(productSearch).toHaveValue('');

    const selectedFilter = page.getByTestId('selected-products-filter');
    await expect(selectedFilter).toHaveText('Seleccionados (2)');

    const productRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/products') productRequests.push(url.search);
    });

    await selectedFilter.click();
    await expect(selectedFilter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: primary.name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: otherBrand.name, exact: true })).toBeVisible();
    expect(productRequests.some((search) => search.includes('brandId=SELECTED'))).toBe(false);

    // La barra inferior abre el resumen desde el ícono/contador del carrito.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.getByTestId('mobile-order-action-bar')).toBeVisible();
    // El indicador de Next Dev Tools se superpone al extremo inferior izquierdo
    // en desarrollo: se quita para que el toque llegue al carrito real.
    await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
    await page.getByTestId('mobile-cart-button').click();

    const summary = page.getByRole('dialog');
    await expect(summary.getByRole('heading', { name: /Resumen y Guardar Pedido/ })).toBeVisible();

    const primaryLine = summary
      .getByTestId('selected-order-item')
      .filter({ hasText: primary.code });
    const otherBrandLine = summary
      .getByTestId('selected-order-item')
      .filter({ hasText: otherBrand.code });

    await expect(primaryLine).toContainText(primary.name);
    await expect(primaryLine).toContainText('$1000.00');
    await expect(otherBrandLine).toContainText(otherBrand.name);
    await expect(otherBrandLine).toContainText('$750.00');

    const primaryQuantity = primaryLine.getByRole('spinbutton', {
      name: `Cantidad en el pedido de ${primary.name}`,
    });
    await expect(primaryQuantity).toHaveValue('2');

    await primaryLine
      .getByRole('button', { name: `Sumar una unidad del pedido para ${primary.name}` })
      .click();
    await expect(primaryQuantity).toHaveValue('3');
    await primaryLine
      .getByRole('button', { name: `Restar una unidad del pedido para ${primary.name}` })
      .click();
    await expect(primaryQuantity).toHaveValue('2');

    // Atajos de media docena / docena desde el carrito.
    await primaryLine.getByRole('button', { name: `Sumar 6 unidades de ${primary.name}` }).click();
    await expect(primaryQuantity).toHaveValue('8');
    await primaryQuantity.fill('2');
    await expect(primaryQuantity).toHaveValue('2');

    await otherBrandLine
      .getByRole('button', { name: `Quitar ${otherBrand.name} del pedido` })
      .click();
    await expect(otherBrandLine).toHaveCount(0);
    await expect(summary.getByTestId('selected-order-items-count')).toContainText('1 ítems');

    await summary.getByRole('button', { name: 'Cerrar resumen del pedido' }).click();

    // El borrador se guarda con debounce: esperar la última edición antes de
    // recargar evita restaurar una versión anterior del carrito.
    await expect
      .poll(() =>
        page.evaluate(() => {
          for (const key of Object.keys(window.localStorage)) {
            if (!key.startsWith('sgi_order_draft:')) continue;
            const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as {
              quantities?: Record<string, number>;
            } | null;
            const quantities = parsed?.quantities ?? {};
            return Object.values(quantities).filter((quantity) => quantity > 0).length;
          }
          return -1;
        }),
      )
      .toBe(1);

    // Al recargar, el borrador restaurado abre "Seleccionados" y muestra el
    // producto recuperado en vez de una pantalla vacía.
    await page.reload();
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

    const restoredFilter = page.getByTestId('selected-products-filter');
    await expect(restoredFilter).toHaveText('Seleccionados (1)');
    await expect(restoredFilter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: primary.name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: otherBrand.name, exact: true })).toHaveCount(0);
    await expect(page.getByText('Seleccioná una marca o buscá un producto')).toHaveCount(0);
  });
});

test.describe('Cuenta y cambio de contraseña @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('entra desde el panel, cambia la clave y conserva la sesión actual', async ({
    page,
    request,
  }) => {
    const user = E2E_USERS.account;

    await loginThroughUi(page, user);
    await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();

    // El acceso a Ajustes está en el header y es táctil en móvil.
    const accountLink = page.getByRole('link', { name: 'Ajustes y cuenta' });
    await expect(accountLink).toBeVisible();
    const accountBox = await accountLink.boundingBox();
    expect(accountBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(accountBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await accountLink.click();
    await expect(page).toHaveURL(/\/settings\/notifications$/);
    await expect(page.getByRole('heading', { name: 'Cuenta y ajustes' })).toBeVisible();
    await expect(page.getByTestId('settings-current-user')).toHaveText(user.username);
    await expect(page.getByTestId('settings-current-role')).toHaveText('Vendedor');
    await expectMobileErgonomics(page, 'notificaciones y cuenta');

    await page.getByTestId('settings-tab-security').click();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(page.getByRole('heading', { name: 'Cambiar contraseña' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectMobileErgonomics(page, 'seguridad y contraseña');

    const currentPassword = page.getByLabel('Contraseña actual', { exact: true });
    const newPassword = page.getByLabel('Nueva contraseña', { exact: true });
    const confirmPassword = page.getByLabel('Confirmar nueva contraseña', { exact: true });

    // Mostrar/ocultar conserva el valor y el control mide 44x44 en móvil.
    const showCurrent = page.getByRole('button', { name: 'Mostrar la contraseña actual' });
    const showCurrentBox = await showCurrent.boundingBox();
    expect(showCurrentBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(showCurrentBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await showCurrent.click();
    await expect(currentPassword).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Ocultar la contraseña actual' }).click();
    await expect(currentPassword).toHaveAttribute('type', 'password');

    await currentPassword.fill(user.password);
    await newPassword.fill(E2E_CHANGED_PASSWORD);
    await confirmPassword.fill(E2E_CHANGED_PASSWORD);
    await expect(currentPassword).toHaveValue(user.password);
    await expect(newPassword).toHaveValue(E2E_CHANGED_PASSWORD);
    await expect(confirmPassword).toHaveValue(E2E_CHANGED_PASSWORD);

    const changeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/change-password' &&
        response.request().method() === 'POST',
    );

    try {
      await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
      expect((await changeResponse).status()).toBe(200);

      await expect(page.getByText(CHANGE_PASSWORD_SUCCESS_MESSAGE)).toBeVisible();

      // Los campos se limpian y el usuario/rol siguen visibles: no hubo logout.
      await expect(currentPassword).toHaveValue('');
      await expect(newPassword).toHaveValue('');
      await expect(confirmPassword).toHaveValue('');
      await expect(page.getByTestId('settings-current-user')).toHaveText(user.username);

      const session = await page.request.get('/api/auth/session');
      expect(session.status()).toBe(200);
      const sessionPayload = (await session.json()) as { user: { username: string } };
      expect(sessionPayload.user.username).toBe(user.username);

      // Navegar al panel confirma que la cookie renovada sigue autenticando.
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();

      // Cerrar sesión desde el menú móvil y volver a entrar con la clave nueva.
      await page.getByRole('button', { name: 'Abrir menú' }).click();
      await page.getByRole('button', { name: 'Cerrar sesión' }).click();
      await expect(page).toHaveURL(/\/login$/);

      await loginThroughUi(page, { username: user.username, password: E2E_CHANGED_PASSWORD });
      await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();
    } finally {
      // Restaurar la clave del fixture E2E aunque la prueba haya fallado.
      const relogin = await request.post('/api/auth/login', {
        data: { username: user.username, password: E2E_CHANGED_PASSWORD },
      });

      if (relogin.ok()) {
        const restore = await request.post('/api/auth/change-password', {
          data: { currentPassword: E2E_CHANGED_PASSWORD, newPassword: user.password },
        });
        expect(restore.status()).toBe(200);
      }

      const fixtureLogin = await request.post('/api/auth/login', { data: user });
      expect(fixtureLogin.status()).toBe(200);
    }
  });
});

test.describe('Búsqueda móvil por tokens y código corto @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('encuentra un cliente por una palabra intermedia y un pedido por #xxxxxx', async ({
    page,
  }) => {
    const client = E2E_CLIENTS.mobileControl;

    await loginThroughUi(page, E2E_USERS.seller);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

    // "Mobile" no es la primera palabra del nombre: la búsqueda multi-token
    // debe encontrarlo igual.
    await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
    const clientDialog = page.getByRole('dialog');
    await expect(clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' })).toBeVisible();
    await clientDialog.getByPlaceholder('Buscar por código, nombre o localidad...').fill('Mobile');
    await expect(
      clientDialog.getByRole('button', { name: new RegExp(`${client.code} - ${client.name}`) }),
    ).toBeVisible();

    // Toma un pedido real del vendedor y búscalo en la bandeja por sus últimos
    // 6 caracteres, tal como se muestran en la tarjeta.
    const response = await page.request.get('/api/orders?pagination=cursor&limit=10');
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as { orders: Array<{ _id: string }> };
    const order = payload.orders[0];
    expect(order).toBeTruthy();
    const shortCode = order._id.slice(-6).toLowerCase();

    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

    const search = page.getByPlaceholder(/Buscar por cliente/);
    await search.fill(`#${shortCode}`);

    const card = page.locator(`[data-order-card][data-order-id="${order._id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('order-short-id')).toContainText(`#${shortCode}`);
    await expectNoHorizontalOverflow(page, 'bandeja filtrada por código corto');
  });
});

test.describe('Alta rápida de cliente desde el pedido @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('crea un cliente inexistente y lo deja seleccionado sin salir de /orders/new', async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now()}`.slice(-8);
    const searchedName = `Farmacia E2E Alta Rápida ${suffix}`;

    let createdId: string | null = null;

    try {
      await loginThroughUi(page, E2E_USERS.seller);
      await page.goto('/orders/new');
      await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

      // Buscar un cliente que no existe en el modal móvil.
      await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
      const clientDialog = page.getByRole('dialog');
      await expect(
        clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' }),
      ).toBeVisible();
      await clientDialog
        .getByPlaceholder('Buscar por código, nombre o localidad...')
        .fill(searchedName);
      await expect(clientDialog.getByText('No se encontraron clientes.')).toBeVisible();
      await expect(clientDialog.getByRole('button', { name: 'Nuevo cliente' })).toBeVisible();

      // Tocar "Crear cliente nuevo" abre el alta rápida sin cambiar de página.
      await clientDialog.getByRole('button', { name: 'Crear cliente nuevo' }).click();

      const quickDialog = page.getByRole('dialog');
      await expect(quickDialog.getByRole('heading', { name: 'Nuevo Cliente' })).toBeVisible();
      await expect(quickDialog.getByLabel(/Nombre \/ Razón Social/)).toHaveValue(searchedName);

      // Código sugerido automáticamente.
      const codeInput = quickDialog.getByLabel(/^Código/);
      await quickDialog.getByRole('button', { name: 'Sugerir código' }).click();
      await expect(codeInput).toHaveValue(/^CLI-/);
      const createdCode = await codeInput.inputValue();

      await quickDialog.getByLabel(/^Dirección/).fill('Av. E2E 123');
      await quickDialog.getByLabel(/^Localidad/).fill('CABA');
      await quickDialog.getByLabel(/^Provincia/).fill('Buenos Aires');
      await quickDialog.getByLabel(/^Descuento General/).fill('10');

      await expectMobileErgonomics(page, 'alta rápida de cliente');

      const createResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/clients' &&
          response.request().method() === 'POST',
      );
      await quickDialog.getByRole('button', { name: 'Guardar cliente' }).click();

      const response = await createResponse;
      expect(response.status()).toBe(200);
      const payload = (await response.json()) as {
        client: { _id: string; code: string; name: string };
      };
      createdId = payload.client._id;
      expect(payload.client.code).toBe(createdCode);
      expect(payload.client.name).toBe(searchedName);

      // El alta se cierra y el cliente creado queda elegido en el pedido actual.
      await expect(quickDialog).toBeHidden();
      await expect(page).toHaveURL(/\/orders\/new$/);
      await expect(
        page.getByRole('button', {
          name: new RegExp(`${createdCode} - ${searchedName}`),
        }),
      ).toBeVisible();
      await expect(page.getByText('Cliente creado y seleccionado exitosamente')).toBeVisible();

      // Guardar el pedido no es necesario para la prueba: seguir en el alta y
      // con el cliente elegido es justamente el requisito.
      await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();
    } finally {
      if (createdId) {
        const login = await request.post('/api/auth/login', { data: E2E_USERS.admin });
        expect(login.status()).toBe(200);
        const deletion = await request.delete(`/api/clients/${createdId}`);
        expect(deletion.status()).toBe(200);
      }
    }
  });
});

interface E2EProductPriceSnapshot {
  _id: string;
  brandId: { _id: string; name: string };
  code: string;
  name: string;
  imageUrl?: string;
  price: number;
  priceWithIva?: number;
}

async function fetchProductPriceSnapshot(
  page: Page,
  code: string,
): Promise<E2EProductPriceSnapshot> {
  const response = await page.request.get(
    `/api/products?search=${encodeURIComponent(code)}&limit=20`,
  );
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as { products: E2EProductPriceSnapshot[] };
  const product = payload.products.find((item) => item.code === code);

  if (!product) throw new Error(`No se encontró el producto E2E ${code}`);

  return product;
}

/** Restaura los precios del seed al terminar la prueba (afectan a otros specs). */
async function restoreProductPrices(page: Page, product: E2EProductPriceSnapshot): Promise<void> {
  const response = await page.request.put(`/api/products/${product._id}`, {
    data: {
      brandId: product.brandId._id,
      code: product.code,
      name: product.name,
      price: product.price,
      priceWithIva: product.priceWithIva,
      imageUrl: product.imageUrl ?? '',
    },
  });

  expect(response.status()).toBe(200);
}

test.describe('Administración móvil de precios @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('filtra por marca, edita un precio y ajusta la marca en porcentaje', async ({ page }) => {
    await loginThroughUi(page, E2E_USERS.admin);

    const primary = await fetchProductPriceSnapshot(page, E2E_PRODUCTS.primary.code);
    const secondary = await fetchProductPriceSnapshot(page, E2E_PRODUCTS.secondary.code);
    const brandId = primary.brandId._id;

    try {
      await page.goto('/backoffice/products');

      // Filtro por marca con chips horizontales y URL compartible.
      const brandFilters = page.getByTestId('backoffice-brand-filter');
      await expect(brandFilters).toBeVisible();
      await brandFilters.getByRole('button', { name: E2E_BRAND.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]brandId=${brandId}`));

      const cards = page.getByTestId('backoffice-product-card');
      const primaryCard = cards.filter({ hasText: primary.code });
      const secondaryCard = cards.filter({ hasText: secondary.code });

      await expect(primaryCard).toBeVisible();
      await expect(secondaryCard).toBeVisible();
      await expect(cards.filter({ hasText: E2E_PRODUCTS.otherBrand.code })).toHaveCount(0);

      // Otros specs pueden dejar productos temporales en la misma marca: el
      // alcance del ajuste debe coincidir con las tarjetas visibles, no con un
      // número fijo del seed.
      const activeBrandProductCount = await cards.count();

      // El botón táctil del buscador mide 44x44 y limpia el término.
      const search = page.getByPlaceholder('Buscar por código, nombre o marca...');
      await search.fill(primary.code);
      const clearSearch = page.getByRole('button', { name: 'Limpiar búsqueda de productos' });
      await expect(clearSearch).toBeVisible();

      const clearBox = await clearSearch.boundingBox();
      expect(clearBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(clearBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      await clearSearch.click();
      await expect(search).toHaveValue('');
      await page.waitForURL(
        (url) =>
          url.pathname === '/backoffice/products' &&
          url.searchParams.get('search') === null &&
          url.searchParams.get('brandId') === brandId,
      );

      // Edición rápida del precio sin perder la posición del scroll.
      await primaryCard.getByRole('button', { name: `Cambiar precio de ${primary.name}` }).click();

      const quickModal = page.getByTestId('quick-price-modal');
      await expect(quickModal).toBeVisible();

      const netInput = quickModal.getByLabel('Precio s/IVA', { exact: true });
      const grossInput = quickModal.getByLabel('Precio c/IVA', { exact: true });

      await netInput.fill('2000');
      await expect.poll(async () => Number(await grossInput.inputValue())).toBe(2420);

      // La posición se mide con el modal ya abierto: guardar no debe mover la lista.
      const scrollBeforeSave = await page.evaluate(() => window.scrollY);

      const quickSave = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/products/${primary._id}` &&
          response.request().method() === 'PUT',
      );
      await quickModal.getByRole('button', { name: 'Guardar precio' }).click();

      expect((await quickSave).status()).toBe(200);
      await expect(quickModal).toBeHidden();
      await expect(primaryCard).toContainText('$2000.00');
      await expect(primaryCard).toContainText('$2420.00');
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeSave);

      // Ajuste porcentual de toda la marca con confirmación explícita.
      await page.getByTestId('bulk-price-open').click();
      const bulkModal = page.getByTestId('bulk-price-modal');
      await expect(bulkModal).toBeVisible();
      await expect(bulkModal.getByLabel('Marca a ajustar')).toHaveValue(brandId);

      await bulkModal.getByLabel('Porcentaje de ajuste').fill('-10');
      await expect(bulkModal.getByTestId('bulk-price-count')).toHaveText(
        `${activeBrandProductCount} producto(s) activo(s)`,
      );

      await bulkModal.getByRole('button', { name: 'Continuar' }).click();
      await expect(bulkModal).toBeHidden();

      const confirmDialog = page.getByRole('dialog');
      await expect(
        confirmDialog.getByRole('heading', { name: 'Ajustar precios por marca' }),
      ).toBeVisible();

      const bulkRequest = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/products/bulk-price' &&
          response.request().method() === 'POST',
      );
      await confirmDialog.getByRole('button', { name: 'Aplicar ajuste' }).click();

      expect((await bulkRequest).status()).toBe(200);
      await expect(confirmDialog).toBeHidden();

      await expect(primaryCard).toContainText('$1800.00');
      await expect(primaryCard).toContainText('$2178.00');
      await expect(secondaryCard).toContainText('$450.00');
      await expect(secondaryCard).toContainText('$544.50');

      // La API devuelve los mismos importes redondeados que la lista.
      const persistedPrimary = await fetchProductPriceSnapshot(page, primary.code);
      const persistedSecondary = await fetchProductPriceSnapshot(page, secondary.code);

      expect(persistedPrimary.price).toBe(1800);
      expect(persistedPrimary.priceWithIva).toBe(2178);
      expect(persistedSecondary.price).toBe(450);
      expect(persistedSecondary.priceWithIva).toBe(544.5);

      await expectMobileErgonomics(page, 'backoffice productos filtrado y con precios');
    } finally {
      // Los precios del seed alimentan otros specs (por ejemplo el carrito del
      // alta): se restauran incluso si la prueba falla.
      await restoreProductPrices(page, primary);
      await restoreProductPrices(page, secondary);
    }
  });
});

/**
 * Deja en IndexedDB una escritura rechazada: el indicador global la muestra
 * como "con error" y no la reenvía sola, así permanece visible durante todo el
 * escenario sin depender de la red.
 */
async function seedFailedOfflineOrder(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('sgi-offline', 2);
      request.onupgradeneeded = () => {
        const upgrade = request.result;
        if (!upgrade.objectStoreNames.contains('order-queue')) {
          upgrade.createObjectStore('order-queue', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
    });

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('order-queue', 'readwrite');
      const now = Date.now();
      transaction.objectStore('order-queue').put({
        id: 'create:e2e-floating-notices',
        kind: 'create',
        method: 'POST',
        url: '/api/orders',
        body: { clientRequestId: 'e2e-floating-notices' },
        clientRequestId: 'e2e-floating-notices',
        status: 'failed',
        createdAt: now,
        updatedAt: now,
        attempts: 1,
        lastError: 'Rechazo permanente simulado por el E2E',
        lastStatus: 400,
        clientName: 'Cliente flotante E2E',
        total: 1000,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB'));
    });

    db.close();
  });
}

/**
 * Indicador offline + chip SSE + teclado virtual: comprueba que los avisos
 * flotantes se apilan sin intersectarse y que, con un campo enfocado, la
 * píldora no intercepta clics.
 */
async function expectFloatingNoticesStacked(page: Page): Promise<void> {
  await loginThroughUi(page, E2E_USERS.seller);
  await seedFailedOfflineOrder(page);

  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

  const syncIndicator = page.getByTestId('offline-sync-indicator');
  const syncIndicatorWrapper = page.getByTestId('offline-sync-indicator-wrapper');
  await expect(syncIndicator).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-offline-sync-visible', 'true');

  // El evento SSE se republica como CustomEvent; con el buscador enfocado la
  // bandeja lo acumula en el chip en vez de refrescar la lista bajo las manos.
  const search = page.getByPlaceholder('Buscar por cliente, producto, código o #pedido...');
  await waitForReactHydration(
    page,
    'input[placeholder="Buscar por cliente, producto, código o #pedido..."]',
  );
  await search.click();
  await expect(search).toBeFocused();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('sgi:order-notification', {
        detail: { targetRole: 'vendor', orderId: null },
      }),
    );
  });

  const chip = page.getByTestId('orders-tray-new-movements');
  await expect(chip).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-tray-chip-visible', 'true');

  const syncBox = await syncIndicatorWrapper.boundingBox();
  const chipBox = await chip.boundingBox();
  expect(syncBox).not.toBeNull();
  expect(chipBox).not.toBeNull();

  if (!syncBox || !chipBox) return;

  // Sin intersección: uno queda completamente por encima del otro.
  expect(overlapArea(syncBox, chipBox)).toBe(0);
  expect(syncBox.y + syncBox.height <= chipBox.y || chipBox.y + chipBox.height <= syncBox.y).toBe(
    true,
  );

  // Ambos centros siguen perteneciendo a su propio botón.
  expect(await buttonLabelAtCenter(page, syncBox)).toBe('Abrir cola de sincronización');
  expect(await buttonLabelAtCenter(page, chipBox)).toBe(
    'Actualizar la bandeja con los nuevos movimientos',
  );

  const viewport = page.viewportSize();
  if (viewport) {
    expect(chipBox.x).toBeGreaterThanOrEqual(0);
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(viewport.width);
  }

  // Teclado virtual: al enfocar el buscador de productos, la píldora offline
  // se oculta y deja pasar los clics al campo.
  await page.goto('/orders/new');
  await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();
  const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
  await waitForReactHydration(page, 'input[placeholder="Buscar producto por nombre o código..."]');

  const html = page.locator('html');
  // En WebKit el primer foco puede adelantarse al efecto que suscribe
  // `focusin`: se repite el foco hasta que el hook refleje el estado.
  await expect(async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await productSearch.click();
    await expect(html).toHaveAttribute('data-mobile-keyboard', 'open', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(productSearch).toBeFocused();

  await expect(syncIndicatorWrapper).toHaveCSS('opacity', '0');
  await expect(syncIndicatorWrapper).toHaveCSS('pointer-events', 'none');

  expect(
    await page.evaluate(() => {
      const indicator = document.querySelector('[data-testid="offline-sync-indicator-wrapper"]');
      if (!indicator) return false;
      const rect = indicator.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit?.closest('[data-testid="offline-sync-indicator-wrapper"]') !== null;
    }),
  ).toBe(false);

  await productSearch.click();
  await expect(productSearch).toBeFocused();

  // Al cerrar el teclado la píldora vuelve y no se apoya sobre la barra de
  // acciones primaria del alta.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(html).not.toHaveAttribute('data-mobile-keyboard', 'open');
  await expect(syncIndicatorWrapper).toHaveCSS('opacity', '1');
  await expect(syncIndicatorWrapper).toHaveCSS('pointer-events', 'auto');

  const actionBar = page.getByTestId('mobile-order-action-bar');
  await expect(actionBar).toBeVisible();
  const actionBarBox = await actionBar.boundingBox();
  const restoredSyncBox = await syncIndicatorWrapper.boundingBox();
  if (actionBarBox && restoredSyncBox) {
    expect(overlapArea(actionBarBox, restoredSyncBox)).toBe(0);
  }
}

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
] as const) {
  test.describe(`Avisos flotantes apilados @ ${viewport.width}px`, () => {
    test.use({ viewport });

    test('indicador offline, chip SSE y teclado virtual no se pisan', async ({ page }) => {
      await expectFloatingNoticesStacked(page);
    });
  });
}

test.describe('Descuento por línea y limpieza de cliente @ 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('edita el descuento desde el resumen y limpia la búsqueda de clientes con la X', async ({
    page,
  }) => {
    const client = E2E_CLIENTS.fullFlow;
    const product = E2E_PRODUCTS.primary;

    await loginThroughUi(page, E2E_USERS.seller);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

    // La hoja de clientes permite limpiar la búsqueda sin borrar carácter por
    // carácter y devuelve el foco al campo para seguir escribiendo.
    await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
    const clientDialog = page.getByRole('dialog');
    await expect(clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' })).toBeVisible();

    const clientSearch = clientDialog.getByPlaceholder('Buscar por código, nombre o localidad...');
    await clientSearch.fill(client.code);
    await expect(clientSearch).toHaveValue(client.code);

    const clearClientSearch = clientDialog.getByRole('button', {
      name: 'Limpiar búsqueda de cliente',
    });
    await expect(clearClientSearch).toBeVisible();
    const clearBox = await clearClientSearch.boundingBox();
    expect(clearBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(clearBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await clearClientSearch.click();
    await expect(clientSearch).toHaveValue('');
    await expect(clientSearch).toBeFocused();
    await expect(clearClientSearch).toHaveCount(0);

    await clientSearch.fill(client.code);
    await clientDialog
      .getByRole('button', { name: new RegExp(`${client.code} - ${client.name}`) })
      .click();
    await expect(clientDialog).toBeHidden();

    // Una línea con el descuento general del cliente (5% sobre $1000).
    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    await productSearch.fill(product.code);
    const card = page.locator('.cv-product-card').filter({ hasText: product.code });
    await expect(card).toBeVisible();

    const quantity = card.getByRole('spinbutton', {
      name: /^Cantidad en el catálogo de/,
    });
    await quantity.fill('1');
    await expect(quantity).toHaveValue('1');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
    await page.getByTestId('mobile-cart-button').click();

    const summary = page.getByRole('dialog');
    await expect(summary.getByRole('heading', { name: /Resumen y Guardar Pedido/ })).toBeVisible();

    const line = summary.getByTestId('selected-order-item').filter({ hasText: product.code });
    await expect(line.locator('img')).toBeVisible();
    const finalTotal = summary.getByTestId('mobile-checkout-final-total');
    await expect(finalTotal).toHaveText('$950.00');

    // El descuento manual se edita en la misma línea del resumen, sin cerrarlo.
    const discountChip = line.getByTestId('selected-order-item-discount-chip');
    await expect(discountChip).toContainText('Desc. 5%');
    await discountChip.click();

    const discountInput = line.getByTestId('selected-order-item-discount-input');
    await expect(discountInput).toBeVisible();
    await expect(discountInput).toBeFocused();
    await discountInput.fill('15');
    await expect(discountInput).toHaveValue('15');
    await expect(finalTotal).toHaveText('$850.00');
    await expect(summary.getByText('Desc. manual por producto:', { exact: true })).toBeVisible();

    // La X de la línea vuelve al descuento de marca/general del cliente.
    await line
      .getByRole('button', { name: `Restaurar descuento de marca para ${product.name}` })
      .click();
    await expect(line.getByTestId('selected-order-item-discount-chip')).toContainText('Desc. 5%');
    await expect(finalTotal).toHaveText('$950.00');
  });
});
