/**
 * Pruebas de lib/visibility-poll.ts, el respaldo por polling de NotificationsBell:
 * - Solo corre cuando el respaldo es necesario (SSE caído) y la pestaña está
 *   visible: el criterio es no emitir requests en pestañas ocultas.
 * - Cada tick revalida las condiciones, aunque el llamador olvide llamar a sync().
 * - sync() repetido no duplica intervalos y stop() los corta.
 *
 * No requiere DOM: la pestaña y la necesidad del respaldo se inyectan como
 * funciones. Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { createVisibilityPoll } from '../lib/visibility-poll';

const INTERVAL_MS = 10_000;

/** Fuente de verdad mutable + contador de ticks para cada caso de prueba. */
function createFixture(initial: { hidden?: boolean; needed?: boolean } = {}) {
  const state = { hidden: initial.hidden ?? false, needed: initial.needed ?? true };
  let ticks = 0;

  const poll = createVisibilityPoll({
    intervalMs: INTERVAL_MS,
    isNeeded: () => state.needed,
    isHidden: () => state.hidden,
    onTick: () => {
      ticks++;
    },
  });

  return { state, poll, tickCount: () => ticks };
}

const withMockTimers = async (run: () => void | Promise<void>) => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await run();
  } finally {
    mock.timers.reset();
  }
};

test('sync arranca el intervalo y consulta una vez por intervalo', async () => {
  await withMockTimers(() => {
    const { poll, tickCount } = createFixture();

    poll.sync();
    assert.equal(poll.isRunning(), true);

    // A un milisegundo del intervalo todavía no debe consultar.
    mock.timers.tick(INTERVAL_MS - 1);
    assert.equal(tickCount(), 0);

    mock.timers.tick(1);
    assert.equal(tickCount(), 1);

    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 2);
  });
});

test('al ocultarse la pestaña el intervalo se pausa y deja de consultar', async () => {
  await withMockTimers(() => {
    const { state, poll, tickCount } = createFixture();

    poll.sync();
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 1);

    // Se oculta la pestaña: sync pausa el intervalo (visibilitychange).
    state.hidden = true;
    poll.sync();
    assert.equal(poll.isRunning(), false);

    // Aunque pase el tiempo, no hay más requests.
    mock.timers.tick(INTERVAL_MS * 5);
    assert.equal(tickCount(), 1);
  });
});

test('sin SSE caído no arranca; si el canal vuelve, sync lo detiene', async () => {
  await withMockTimers(() => {
    const { state, poll, tickCount } = createFixture({ needed: false });

    // SSE sano: el respaldo queda apagado aunque la pestaña esté visible.
    poll.sync();
    assert.equal(poll.isRunning(), false);
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 0);

    // El SSE se cae: sync activa el respaldo.
    state.needed = true;
    poll.sync();
    assert.equal(poll.isRunning(), true);
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 1);

    // El SSE vuelve: sync lo apaga otra vez.
    state.needed = false;
    poll.sync();
    assert.equal(poll.isRunning(), false);
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 1);
  });
});

test('un tick no consulta si la pestaña se ocultó sin llamar a sync', async () => {
  await withMockTimers(() => {
    const { state, poll, tickCount } = createFixture();

    poll.sync();
    state.hidden = true; // Simula el evento perdido: nadie llamó a sync().

    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 0);

    state.hidden = false;
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 1);
  });
});

test('stop corta el intervalo y sync puede reanudarlo', async () => {
  await withMockTimers(() => {
    const { poll, tickCount } = createFixture();

    poll.sync();
    poll.stop();
    assert.equal(poll.isRunning(), false);
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 0);

    poll.sync();
    assert.equal(poll.isRunning(), true);
    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 1);
  });
});

test('sync repetido no duplica el intervalo', async () => {
  await withMockTimers(() => {
    const { poll, tickCount } = createFixture();

    poll.sync();
    poll.sync();
    poll.sync();

    mock.timers.tick(INTERVAL_MS);
    assert.equal(tickCount(), 1);
  });
});
