/**
 * Pruebas de `lib/clipboard.ts`:
 * - usa `navigator.clipboard.writeText` cuando la Clipboard API existe;
 * - cae a `document.execCommand('copy')` en navegadores sin la API;
 * - si el fallback falla, rechaza y saca el textarea temporal del documento.
 *
 * Se reemplazan navigator y document; no requiere navegador ni base de datos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyTextToClipboard } from '../lib/clipboard';

interface TestContextLike {
  after: (fn: () => void) => void;
}

interface ClipboardStub {
  writeText: (text: string) => Promise<void>;
}

interface TextareaStub {
  value: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  select: () => void;
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }

  delete (globalThis as Record<string, unknown>)[name];
}

function installNavigator(t: TestContextLike, clipboard?: ClipboardStub): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: clipboard ? { clipboard } : {},
  });
  t.after(() => restoreGlobal('navigator', descriptor));
}

function installDocument(
  t: TestContextLike,
  options: { execCommand?: (command: string) => boolean } = {},
): {
  getTextarea: () => TextareaStub;
  appended: TextareaStub[];
  removed: TextareaStub[];
  commands: string[];
} {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const appended: TextareaStub[] = [];
  const removed: TextareaStub[] = [];
  const commands: string[] = [];
  let textarea: TextareaStub | undefined;

  const documentStub = {
    body: {
      appendChild(node: TextareaStub) {
        appended.push(node);
      },
      removeChild(node: TextareaStub) {
        removed.push(node);
      },
    },
    createElement(tag: string) {
      assert.equal(tag, 'textarea');

      const element: TextareaStub = {
        value: '',
        style: {},
        attributes: {},
        setAttribute(name: string, value: string) {
          element.attributes[name] = value;
        },
        select() {},
      };
      textarea = element;

      return element;
    },
    execCommand(command: string) {
      commands.push(command);
      return options.execCommand ? options.execCommand(command) : true;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentStub,
  });
  t.after(() => restoreGlobal('document', descriptor));

  return {
    getTextarea: () => {
      if (!textarea) throw new Error('No se creó el textarea del fallback');
      return textarea;
    },
    appended,
    removed,
    commands,
  };
}

test('usa navigator.clipboard.writeText cuando está disponible', async (t) => {
  const writes: string[] = [];

  installNavigator(t, {
    writeText: async (text: string) => {
      writes.push(text);
    },
  });

  await copyTextToClipboard('datos estructurados');

  assert.deepEqual(writes, ['datos estructurados']);
});

test('cae a execCommand cuando no hay Clipboard API', async (t) => {
  installNavigator(t);
  const documentStub = installDocument(t);

  await copyTextToClipboard('respaldo para iOS');

  const textarea = documentStub.getTextarea();
  assert.equal(textarea.value, 'respaldo para iOS');
  assert.equal(textarea.attributes.readonly, '');
  assert.deepEqual(documentStub.commands, ['copy']);
  assert.deepEqual(documentStub.appended, [textarea]);
  assert.deepEqual(documentStub.removed, [textarea]);
});

test('si execCommand falla, rechaza y limpia el textarea temporal', async (t) => {
  installNavigator(t);
  const documentStub = installDocument(t, { execCommand: () => false });

  await assert.rejects(
    () => copyTextToClipboard('no se puede copiar'),
    /No se pudo copiar el texto/,
  );

  const textarea = documentStub.getTextarea();
  assert.deepEqual(documentStub.appended, [textarea]);
  assert.deepEqual(documentStub.removed, [textarea]);
});
