/**
 * Pruebas de lib/haptics: no debe romper en navegadores sin Vibration API y
 * respeta la preferencia local y `prefers-reduced-motion`.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HAPTICS_STORAGE_KEY,
  isHapticsSupported,
  setHapticsEnabled,
  vibrateOnTap,
} from '../lib/haptics';

function createStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function installGlobals(navigatorValue: object, windowValue?: object): () => void {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: navigatorValue,
  });

  if (windowValue) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: windowValue,
    });
  }

  return () => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');

    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  };
}

function createWindow(options: { storage?: Storage; reducedMotion?: boolean } = {}) {
  const storage = options.storage ?? createStorage();

  return {
    localStorage: storage,
    matchMedia: (query: string) => ({
      matches: options.reducedMotion === true && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  };
}

test('no lanza si navigator.vibrate no existe', () => {
  const restore = installGlobals({ userAgent: 'Mozilla/5.0 Chrome/120' }, createWindow());

  try {
    assert.doesNotThrow(() => vibrateOnTap());
    assert.equal(vibrateOnTap(), false);
  } finally {
    restore();
  }
});

test('vibra en un navegador compatible con la preferencia activa', () => {
  const patterns: Array<number | number[]> = [];
  const restore = installGlobals(
    {
      userAgent: 'Mozilla/5.0 Chrome/120',
      vibrate: (pattern: number | number[]) => {
        patterns.push(pattern);
        return true;
      },
    },
    createWindow(),
  );

  try {
    assert.equal(vibrateOnTap(), true);
    assert.deepEqual(patterns, [8]);
  } finally {
    restore();
  }
});

test('propaga un patrón propio para los atajos de cantidad', () => {
  const patterns: Array<number | number[]> = [];
  const restore = installGlobals(
    {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
      vibrate: (pattern: number | number[]) => {
        patterns.push(pattern);
        return true;
      },
    },
    createWindow(),
  );

  try {
    assert.equal(vibrateOnTap([6, 20, 6]), true);
    assert.deepEqual(patterns, [[6, 20, 6]]);
  } finally {
    restore();
  }
});

test('isHapticsSupported exige Vibration API y descarta Safari/iOS', () => {
  const asNavigator = (value: object): Navigator => value as Navigator;
  const vibrate = () => true;

  assert.equal(isHapticsSupported(null), false);
  assert.equal(isHapticsSupported(undefined), false);
  assert.equal(
    isHapticsSupported(asNavigator({ userAgent: 'Mozilla/5.0 Chrome/120' })),
    false,
    'sin navigator.vibrate no hay soporte',
  );
  assert.equal(
    isHapticsSupported(
      asNavigator({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', vibrate }),
    ),
    true,
  );
  assert.equal(
    isHapticsSupported(
      asNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605 Safari/605',
        vibrate,
      }),
    ),
    false,
    'Safari de escritorio expone vibrate como no-op',
  );
  assert.equal(
    isHapticsSupported(
      asNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605',
        maxTouchPoints: 5,
        vibrate,
      }),
    ),
    false,
    'iPadOS se presenta como Macintosh y el touch lo delata',
  );
});

test('respeta la preferencia desactivada y el movimiento reducido', () => {
  const storage = createStorage();
  setHapticsEnabled(false, storage);
  const patterns: Array<number | number[]> = [];
  const vibrateNavigator = {
    userAgent: 'Mozilla/5.0 Chrome/120',
    vibrate: (pattern: number | number[]) => {
      patterns.push(pattern);
      return true;
    },
  };

  let restore = installGlobals(vibrateNavigator, createWindow({ storage }));
  try {
    assert.equal(vibrateOnTap(), false);
  } finally {
    restore();
  }

  const enabledStorage = createStorage();
  restore = installGlobals(
    vibrateNavigator,
    createWindow({ storage: enabledStorage, reducedMotion: true }),
  );
  try {
    assert.equal(vibrateOnTap(), false);
  } finally {
    restore();
  }

  assert.deepEqual(patterns, []);
});

test('no hace nada en iOS/Safari aunque exista navigator.vibrate', () => {
  const patterns: Array<number | number[]> = [];
  const restore = installGlobals(
    {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      vibrate: (pattern: number | number[]) => {
        patterns.push(pattern);
        return true;
      },
    },
    createWindow(),
  );

  try {
    assert.equal(vibrateOnTap(), false);
    assert.deepEqual(patterns, []);
  } finally {
    restore();
  }
});

test('la preferencia usa la clave sgi_haptics', () => {
  const storage = createStorage();

  setHapticsEnabled(false, storage);
  assert.equal(storage.getItem(HAPTICS_STORAGE_KEY), '0');
  setHapticsEnabled(true, storage);
  assert.equal(storage.getItem(HAPTICS_STORAGE_KEY), '1');
});
