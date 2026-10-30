/**
 * Pruebas de lib/focus-trap.ts y del marcado accesible de ConfirmDialog:
 * - Tab/Shift+Tab envuelven en los extremos y entran al diálogo si el foco
 *   quedó fuera.
 * - Flechas/Home/End calculan el ítem siguiente de la bandeja de notificaciones.
 * - Solo se consideran enfocables los elementos visibles y habilitados.
 * - ConfirmDialog expone role="dialog", aria-modal y un nombre accesible.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ConfirmDialog from '../components/ConfirmDialog';
import {
  getFocusableElements,
  getRovingIndex,
  getWrappedFocusIndex,
  isElementVisible,
} from '../lib/focus-trap';

test('Tab en el último elemento vuelve al primero y Shift+Tab en el primero va al último', () => {
  assert.equal(getWrappedFocusIndex(2, 3, false), 0);
  assert.equal(getWrappedFocusIndex(0, 3, true), 2);
});

test('Tab en el medio deja que el navegador mueva el foco', () => {
  assert.equal(getWrappedFocusIndex(1, 3, false), null);
  assert.equal(getWrappedFocusIndex(1, 3, true), null);
});

test('si el foco está fuera del diálogo, Tab entra por el extremo correcto', () => {
  assert.equal(getWrappedFocusIndex(-1, 3, false), 0);
  assert.equal(getWrappedFocusIndex(-1, 3, true), 2);
  assert.equal(getWrappedFocusIndex(0, 0, false), null);
});

test('las flechas recorren las notificaciones en forma circular', () => {
  assert.equal(getRovingIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(getRovingIndex(-1, 3, 'ArrowUp'), 2);
  assert.equal(getRovingIndex(0, 3, 'ArrowDown'), 1);
  assert.equal(getRovingIndex(2, 3, 'ArrowDown'), 0);
  assert.equal(getRovingIndex(0, 3, 'ArrowUp'), 2);
  assert.equal(getRovingIndex(1, 3, 'Home'), 0);
  assert.equal(getRovingIndex(1, 3, 'End'), 2);
  assert.equal(getRovingIndex(0, 0, 'ArrowDown'), null);
});

function fakeElement(options: {
  hidden?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  ariaHidden?: boolean;
}): HTMLElement {
  const attributes: Record<string, string> = {};
  if (options.disabled) attributes.disabled = '';
  if (options.ariaHidden) attributes['aria-hidden'] = 'true';

  return {
    hidden: options.hidden ?? false,
    tabIndex: options.tabIndex ?? 0,
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
  } as unknown as HTMLElement;
}

test('getFocusableElements descarta ocultos, deshabilitados y tabindex negativos', () => {
  const visible = fakeElement({});
  const hidden = fakeElement({ hidden: true });
  const ariaHidden = fakeElement({ ariaHidden: true });
  const disabled = fakeElement({ disabled: true });
  const negativeTabIndex = fakeElement({ tabIndex: -1 });

  const container = {
    querySelectorAll: () => [visible, hidden, ariaHidden, disabled, negativeTabIndex],
  } as unknown as HTMLElement;

  assert.deepEqual(getFocusableElements(container), [visible]);
});

test('isElementVisible respeta hidden y aria-hidden', () => {
  assert.equal(isElementVisible(fakeElement({})), true);
  assert.equal(isElementVisible(fakeElement({ hidden: true })), false);
  assert.equal(isElementVisible(fakeElement({ ariaHidden: true })), false);
});

test('ConfirmDialog expone el rol, aria-modal y el nombre del diálogo', () => {
  const html = renderToStaticMarkup(
    createElement(ConfirmDialog, {
      open: true,
      title: 'Eliminar pedido',
      message: 'Esta acción no se puede deshacer.',
      onConfirm: () => undefined,
      onClose: () => undefined,
    }),
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.match(html, /Eliminar pedido/);
});

test('ConfirmDialog no renderiza nada cuando está cerrado', () => {
  const html = renderToStaticMarkup(
    createElement(ConfirmDialog, {
      open: false,
      title: 'Eliminar pedido',
      message: 'Esta acción no se puede deshacer.',
      onConfirm: () => undefined,
      onClose: () => undefined,
    }),
  );

  assert.equal(html, '');
});
