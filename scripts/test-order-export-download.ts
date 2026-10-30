/**
 * Pruebas de `lib/order-export-download.ts`:
 * - descarga normal con el nombre que llega en `Content-Disposition`;
 * - compartir un `File` real con nombre y MIME del formato elegido;
 * - fallback a descarga si `navigator.canShare` rechaza los archivos o la hoja
 *   nativa falla;
 * - cancelar la hoja nativa no dispara una descarga inesperada.
 *
 * Se reemplazan fetch, document, URL y navigator; no requiere navegador ni base
 * de datos.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ORDER_EXPORT_CSV_MIME, ORDER_EXPORT_XLSX_MIME } from '../lib/order-export';
import { canShareOrderExportFiles, downloadOrderExport } from '../lib/order-export-download';

interface TestContextLike {
  after: (fn: () => void) => void;
}

interface ShareOptions {
  /** `false` simula un navegador sin Web Share API. */
  supported?: boolean;
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
}

interface NavigatorStub {
  shared: ShareData[];
  canShareCalls: ShareData[];
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }

  delete (globalThis as Record<string, unknown>)[name];
}

function installNavigator(t: TestContextLike, options: ShareOptions = {}): NavigatorStub {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const shared: ShareData[] = [];
  const canShareCalls: ShareData[] = [];
  const supported = options.supported ?? true;

  const navigatorStub = supported
    ? {
        canShare(data: ShareData): boolean {
          canShareCalls.push(data);
          return options.canShare ? options.canShare(data) : true;
        },
        async share(data: ShareData): Promise<void> {
          if (options.share) {
            await options.share(data);
            return;
          }

          shared.push(data);
        },
      }
    : {};

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: navigatorStub,
  });
  t.after(() => restoreGlobal('navigator', descriptor));

  return { shared, canShareCalls };
}

function installDocument(t: TestContextLike): Array<{ href: string; download: string }> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const clicks: Array<{ href: string; download: string }> = [];

  const documentStub = {
    body: {
      appendChild: () => undefined,
    },
    createElement(tag: string) {
      assert.equal(tag, 'a');

      const link = {
        href: '',
        download: '',
        style: {} as Record<string, string>,
        click() {
          clicks.push({ href: link.href, download: link.download });
        },
        remove() {},
      };

      return link;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentStub,
  });
  t.after(() => restoreGlobal('document', descriptor));

  return clicks;
}

function installObjectUrls(t: TestContextLike): { created: Blob[]; revoked: string[] } {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created: Blob[] = [];
  const revoked: string[] = [];

  URL.createObjectURL = (blob: Blob) => {
    created.push(blob);
    return `blob:order-export-${created.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };

  t.after(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  return { created, revoked };
}

function stubExportFetch(
  t: TestContextLike,
  options: {
    filename?: string;
    contentType?: string;
    body?: string;
    status?: number;
    error?: string;
  } = {},
): Array<{ url: string; init?: RequestInit }> {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const {
    filename = 'pedidos-2026-10-24.csv',
    contentType = ORDER_EXPORT_CSV_MIME,
    body = 'ID;Cliente\n1;Farmacia E2E',
    status = 200,
    error,
  } = options;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });

    if (status >= 400) {
      return new Response(JSON.stringify({ error: error ?? 'Error del servidor' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(body, {
      status,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return calls;
}

test('sin modo compartir descarga el archivo con el nombre del servidor', async (t) => {
  const { shared } = installNavigator(t);
  const clicks = installDocument(t);
  const objectUrls = installObjectUrls(t);
  stubExportFetch(t);

  const result = await downloadOrderExport('/api/orders/export?format=csv', 'csv');

  assert.deepEqual(result, {
    filename: 'pedidos-2026-10-24.csv',
    delivery: 'downloaded',
  });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].download, 'pedidos-2026-10-24.csv');
  assert.equal(clicks[0].href, 'blob:order-export-1');
  assert.equal(objectUrls.created.length, 1);
  assert.equal(shared.length, 0, 'no debe abrir la hoja nativa sin pedirlo');
});

test('con share comparte un File con el nombre, MIME y título del pedido', async (t) => {
  const { shared, canShareCalls } = installNavigator(t);
  const clicks = installDocument(t);
  installObjectUrls(t);
  stubExportFetch(t);

  const result = await downloadOrderExport('/api/orders/export?format=csv', 'csv', {
    share: true,
    title: 'Pedidos CSV',
  });

  assert.deepEqual(result, {
    filename: 'pedidos-2026-10-24.csv',
    delivery: 'shared',
  });
  assert.equal(canShareCalls.length, 1);
  assert.equal(canShareCalls[0].files?.length, 1);
  assert.equal(canShareCalls[0].files?.[0].name, 'pedidos-2026-10-24.csv');
  assert.equal(canShareCalls[0].files?.[0].type, ORDER_EXPORT_CSV_MIME);

  assert.equal(shared.length, 1);
  assert.equal(shared[0].title, 'Pedidos CSV');
  assert.equal(shared[0].files?.length, 1);
  assert.equal(shared[0].files?.[0].name, 'pedidos-2026-10-24.csv');
  assert.equal(clicks.length, 0, 'compartir no debe disparar la descarga');
});

test('si canShare rechaza los archivos, descarga como fallback', async (t) => {
  const { shared, canShareCalls } = installNavigator(t, { canShare: () => false });
  const clicks = installDocument(t);
  installObjectUrls(t);
  stubExportFetch(t, {
    filename: 'pedidos-2026-10-24.xlsx',
    contentType: ORDER_EXPORT_XLSX_MIME,
  });

  const result = await downloadOrderExport('/api/orders/export?format=xlsx', 'xlsx', {
    share: true,
    title: 'Pedidos Excel',
  });

  assert.equal(result.delivery, 'downloaded');
  assert.equal(canShareCalls.length, 1);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].download, 'pedidos-2026-10-24.xlsx');
  assert.equal(shared.length, 0);
});

test('si la hoja nativa falla, descarga como fallback', async (t) => {
  installNavigator(t, {
    share: async () => {
      throw new Error('NotAllowedError');
    },
  });
  const clicks = installDocument(t);
  installObjectUrls(t);
  stubExportFetch(t);

  const result = await downloadOrderExport('/api/orders/export?format=csv', 'csv', {
    share: true,
  });

  assert.equal(result.delivery, 'downloaded');
  assert.equal(clicks.length, 1);
});

test('cancelar la hoja nativa no dispara una descarga inesperada', async (t) => {
  installNavigator(t, {
    share: async () => {
      const error = new Error('Abortado por el usuario');
      error.name = 'AbortError';
      throw error;
    },
  });
  const clicks = installDocument(t);
  installObjectUrls(t);
  stubExportFetch(t);

  const result = await downloadOrderExport('/api/orders/export?format=csv', 'csv', {
    share: true,
  });

  assert.deepEqual(result, {
    filename: 'pedidos-2026-10-24.csv',
    delivery: 'cancelled',
  });
  assert.equal(clicks.length, 0);
});

test('canShareOrderExportFiles consulta el MIME y la extensión de cada formato', (t) => {
  const { canShareCalls } = installNavigator(t);

  assert.equal(canShareOrderExportFiles('csv'), true);
  assert.equal(canShareOrderExportFiles('xlsx'), true);
  assert.equal(canShareCalls.length, 2);

  assert.equal(canShareCalls[0].files?.[0].type, ORDER_EXPORT_CSV_MIME);
  assert.match(canShareCalls[0].files?.[0].name ?? '', /^pedidos-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(canShareCalls[1].files?.[0].type, ORDER_EXPORT_XLSX_MIME);
  assert.match(canShareCalls[1].files?.[0].name ?? '', /^pedidos-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('canShareOrderExportFiles devuelve false sin Web Share API', (t) => {
  installNavigator(t, { supported: false });

  assert.equal(canShareOrderExportFiles('csv'), false);
  assert.equal(canShareOrderExportFiles('xlsx'), false);
});

test('un error de la API conserva el mensaje del servidor', async (t) => {
  installNavigator(t);
  installDocument(t);
  installObjectUrls(t);
  stubExportFetch(t, { status: 403, error: 'No autorizado para exportar pedidos' });

  await assert.rejects(
    downloadOrderExport('/api/orders/export?format=csv', 'csv'),
    /No autorizado para exportar pedidos/,
  );
});
