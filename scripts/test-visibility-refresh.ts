/**
 * Pruebas del tracker de visibilidad usado por useVisibilityRefresh:
 * - Ocultarse 5 s y volver no revalida.
 * - Ocultarse 40 s y volver sí revalida.
 * - Varios eventos seguidos respetan `minIntervalMs`.
 *
 * El reloj es explícito (se pasa `now` en cada llamada), así que no depende de
 * timers reales ni de un DOM.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_VISIBILITY_REFRESH_MS,
  createVisibilityRefreshTracker,
  shouldRefreshAfterVisibility,
} from '../hooks/useVisibilityRefresh';

const START = 1_000_000;

test('oculto 5 s no refresca al volver', () => {
  assert.equal(DEFAULT_VISIBILITY_REFRESH_MS, 30_000);
  assert.equal(
    shouldRefreshAfterVisibility({ hiddenAt: START, lastRefreshAt: 0 }, START + 5_000),
    false,
  );

  const tracker = createVisibilityRefreshTracker();
  tracker.markHidden(START);
  assert.equal(tracker.shouldRefreshOnVisible(START + 5_000), false);
});

test('oculto 40 s refresca al volver', () => {
  assert.equal(
    shouldRefreshAfterVisibility({ hiddenAt: START, lastRefreshAt: 0 }, START + 40_000),
    true,
  );

  const tracker = createVisibilityRefreshTracker();
  tracker.markHidden(START);
  assert.equal(tracker.shouldRefreshOnVisible(START + 40_000), true);
});

test('dos eventos seguidos respetan minIntervalMs', () => {
  const tracker = createVisibilityRefreshTracker({
    minHiddenMs: 30_000,
    minIntervalMs: 30_000,
  });

  // Primera vuelta después de 40 s: revalida y registra el refresco.
  tracker.markHidden(START);
  assert.equal(tracker.shouldRefreshOnVisible(START + 40_000), true);
  tracker.markRefreshed(START + 40_000);

  // Un refresco explícito mientras sigue oculta no debe habilitar otra
  // consulta al volver 5 s después, aunque la ausencia total supere 30 s.
  tracker.markHidden(START + 41_000);
  tracker.markRefreshed(START + 76_000);
  assert.equal(tracker.shouldRefreshOnVisible(START + 81_000), false);

  // Pasada la ventana mínima desde el último refresco, sí vuelve a revalidar.
  tracker.markHidden(START + 82_000);
  assert.equal(tracker.shouldRefreshOnVisible(START + 122_000), true);
});

test('varios eventos visibles sin una nueva ocultación no duplican el refresco', () => {
  const tracker = createVisibilityRefreshTracker();

  tracker.markHidden(START);
  assert.equal(tracker.shouldRefreshOnVisible(START + 40_000), true);
  tracker.markRefreshed(START + 40_000);

  // focus/pageshow después de visibilitychange: hiddenAt ya quedó en null.
  assert.equal(tracker.shouldRefreshOnVisible(START + 40_001), false);
  assert.equal(tracker.shouldRefreshOnVisible(START + 40_002), false);
});
