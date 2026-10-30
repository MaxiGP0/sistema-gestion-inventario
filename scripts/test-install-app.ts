/**
 * Pruebas de la instalación PWA (lib/install-app.ts y app/manifest.ts):
 * - El aviso no se muestra si la app ya está instalada o el usuario lo cerró.
 * - `beforeinstallprompt` usa `prompt()` y respeta la elección del usuario.
 * - Se detecta iOS/iPadOS para mostrar la ayuda de "Agregar a pantalla de inicio".
 * - El manifiesto conserva display_override, shortcuts e iconos de 192x192.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import manifest from '../app/manifest';
import { FULLSCREEN_REQUEST_EVENT, isAppFullscreen, requestAppFullscreen } from '../lib/fullscreen';
import {
  INSTALL_DISMISSED_STORAGE_KEY,
  dismissInstall,
  getInstallBannerState,
  isInstallDismissed,
  isIosDevice,
  isStandaloneDisplayMode,
  promptInstall,
  type BeforeInstallPromptEvent,
} from '../lib/install-app';

const matchMediaFor =
  (...matchingQueries: string[]) =>
  (query: string) => ({
    matches: matchingQueries.includes(query),
  });

test('detecta standalone por display-mode o por navigator.standalone', () => {
  assert.equal(isStandaloneDisplayMode(matchMediaFor('(display-mode: standalone)'), false), true);
  assert.equal(isStandaloneDisplayMode(matchMediaFor('(display-mode: fullscreen)'), false), true);
  assert.equal(isStandaloneDisplayMode(matchMediaFor('(display-mode: minimal-ui)'), false), true);
  assert.equal(isStandaloneDisplayMode(matchMediaFor('(display-mode: browser)'), false), false);
  assert.equal(isStandaloneDisplayMode(undefined, true), true);
  assert.equal(isStandaloneDisplayMode(undefined, false), false);
});

test('el aviso no aparece si la app ya está instalada', () => {
  assert.equal(
    getInstallBannerState({
      installed: true,
      dismissed: false,
      hasPrompt: true,
      ios: true,
    }),
    'hidden',
  );
});

test('el aviso no reaparece si el usuario lo cerró', () => {
  assert.equal(
    getInstallBannerState({
      installed: false,
      dismissed: true,
      hasPrompt: true,
      ios: false,
    }),
    'hidden',
  );
});

test('sin evento de instalación no se muestra nada en desktop y sí la ayuda en iOS', () => {
  assert.equal(
    getInstallBannerState({
      installed: false,
      dismissed: false,
      hasPrompt: false,
      ios: false,
    }),
    'hidden',
  );
  assert.equal(
    getInstallBannerState({
      installed: false,
      dismissed: false,
      hasPrompt: false,
      ios: true,
    }),
    'ios-help',
  );
  assert.equal(
    getInstallBannerState({
      installed: false,
      dismissed: false,
      hasPrompt: true,
      ios: false,
    }),
    'prompt',
  );
});

test('el flujo de beforeinstallprompt llama a prompt() y devuelve la elección', async () => {
  let promptCalls = 0;
  const acceptedEvent = {
    prompt: async () => {
      promptCalls += 1;
    },
    userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
  } as unknown as BeforeInstallPromptEvent;

  assert.equal(await promptInstall(acceptedEvent), 'accepted');
  assert.equal(promptCalls, 1);

  const dismissedEvent = {
    prompt: async () => {
      promptCalls += 1;
    },
    userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
  } as unknown as BeforeInstallPromptEvent;

  assert.equal(await promptInstall(dismissedEvent), 'dismissed');
  assert.equal(promptCalls, 2);
});

test('reconoce iPhone, iPad y iPadOS presentado como Macintosh', () => {
  assert.equal(
    isIosDevice(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    ),
    true,
  );
  assert.equal(
    isIosDevice(
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    ),
    true,
  );
  assert.equal(
    isIosDevice(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
      0,
    ),
    false,
  );
  assert.equal(
    isIosDevice(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
      5,
    ),
    true,
  );
  assert.equal(
    isIosDevice(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
    ),
    false,
  );
});

test('lee y persiste el cierre del aviso en localStorage', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };

  assert.equal(isInstallDismissed(storage), false);

  dismissInstall(storage);

  assert.equal(values.get(INSTALL_DISMISSED_STORAGE_KEY), '1');
  assert.equal(isInstallDismissed(storage), true);
});

test('un almacenamiento bloqueado no rompe la detección', () => {
  const brokenStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  assert.equal(isInstallDismissed(brokenStorage), false);
  assert.doesNotThrow(() => dismissInstall(brokenStorage));
});

test('la pantalla completa sólo se pide por una acción explícita', async () => {
  const standardCalls: Array<FullscreenOptions | undefined> = [];
  const standardDocument = {
    fullscreenElement: null,
    documentElement: {
      requestFullscreen: (options?: FullscreenOptions) => {
        standardCalls.push(options);
        return Promise.resolve();
      },
    },
  } as unknown as Document;

  assert.equal(isAppFullscreen(standardDocument), false);
  await requestAppFullscreen(standardDocument);
  assert.deepEqual(standardCalls, [{ navigationUI: 'hide' }]);

  let webkitCalls = 0;
  const webkitDocument = {
    fullscreenElement: null,
    documentElement: {
      webkitRequestFullscreen: () => {
        webkitCalls += 1;
      },
    },
  } as unknown as Document;

  await requestAppFullscreen(webkitDocument);
  assert.equal(webkitCalls, 1);

  const unsupportedDocument = {
    fullscreenElement: null,
    documentElement: {
      requestFullscreen: undefined,
      webkitRequestFullscreen: undefined,
    },
  } as unknown as Document;

  assert.equal(requestAppFullscreen(unsupportedDocument), null);

  let alreadyFullscreenCalls = 0;
  const fullscreenDocument = {
    fullscreenElement: {},
    documentElement: {
      requestFullscreen: () => {
        alreadyFullscreenCalls += 1;
        return Promise.resolve();
      },
    },
  } as unknown as Document;

  assert.equal(isAppFullscreen(fullscreenDocument), true);
  assert.equal(requestAppFullscreen(fullscreenDocument), null);
  assert.equal(alreadyFullscreenCalls, 0);
});

test('AutoFullscreen no escucha gestos globales ni pide fullscreen en cada toque', async () => {
  const source = await readFile(
    new URL('../components/AutoFullscreen.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /addEventListener\(\s*['"](?:pointerdown|touchend|click)['"]/);
  assert.doesNotMatch(source, /isMobileDevice/);
  assert.match(source, /FULLSCREEN_REQUEST_EVENT/);
  assert.equal(FULLSCREEN_REQUEST_EVENT, 'sgi:request-fullscreen');
});

test('NetworkStatus usa safe-area y no se superpone con position fixed', async () => {
  const source = await readFile(
    new URL('../components/NetworkStatus.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /env\(safe-area-inset-top\)/);
  assert.doesNotMatch(source, /fixed\s+top-0/);
  assert.match(source, /data-testid="network-status"/);
});

test('el manifiesto define display, atajos e iconos de 192x192', () => {
  const result = manifest();

  assert.equal(result.display, 'standalone');
  assert.deepEqual(result.display_override, ['fullscreen', 'standalone', 'minimal-ui']);
  assert.equal(result.theme_color, '#0b0d9f');
  assert.equal(result.name, 'Sistema de Gestión de Inventario');
  assert.equal(result.short_name, 'Inventario');

  assert.deepEqual(
    result.shortcuts?.map((shortcut) => ({
      name: shortcut.name,
      url: shortcut.url,
      iconSizes: shortcut.icons?.map((icon) => icon.sizes),
    })),
    [
      { name: 'Nuevo Pedido', url: '/orders/new', iconSizes: ['192x192'] },
      { name: 'Mis Pedidos', url: '/orders', iconSizes: ['192x192'] },
      { name: 'Catálogo', url: '/catalog', iconSizes: ['192x192'] },
    ],
  );
});
