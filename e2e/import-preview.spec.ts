import { expect, test } from '@playwright/test';
import { E2E_BRAND, E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

const PREVIEW_PRODUCT_CODE = 'E2E-IMP-PREVIEW-001';
const PRICE_EXISTING_CODE = 'E2E-IMP-PRICE-001';
const PRICE_NEW_CODE = 'E2E-IMP-PRICE-002';

test.describe('Importación de catálogo con preview', () => {
  test('valida el archivo, muestra errores por fila y no escribe hasta confirmar', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.admin);
    await page.goto('/backoffice/import');
    await expect(page.getByRole('heading', { name: /Importador de Archivos Excel/ })).toBeVisible();

    // El selector de modo solo está disponible para productos.
    const modeGroup = page.getByRole('group', { name: 'Campos a actualizar' });
    await expect(modeGroup).toBeVisible();
    await page.getByRole('button', { name: 'Cartera de Clientes' }).click();
    await expect(modeGroup).toHaveCount(0);
    await page.getByRole('button', { name: 'Catálogo de Productos' }).click();
    await expect(modeGroup).toBeVisible();

    const csv = [
      'Marca,Codigo,Nombre,Precio',
      `E2E Laboratorio,${PREVIEW_PRODUCT_CODE},Producto Preview,123.45`,
      'E2E Laboratorio,E2E-IMP-PREVIEW-002,Producto Inválido,-10',
      `E2E Laboratorio,${PREVIEW_PRODUCT_CODE},Producto Duplicado,50`,
    ].join('\n');

    await page.locator('#excel-file-input').setInputFiles({
      name: 'productos-preview.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });

    const previewResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/catalog/import' &&
        response.request().method() === 'POST',
    );

    await page.getByRole('button', { name: 'Previsualizar y validar archivo' }).click();
    expect((await previewResponse).status()).toBe(200);

    const preview = page.getByTestId('catalog-import-preview');

    await expect(preview).toBeVisible();
    await expect(
      preview.getByText(
        'Todavía no se escribió nada. Revisá el resumen y confirmá la importación.',
      ),
    ).toBeVisible();

    // Resumen: 3 filas, 1 válida, 2 omitidas y 1 duplicada dentro del archivo.
    await expect(page.getByTestId('catalog-import-total')).toHaveText('3');
    await expect(page.getByTestId('catalog-import-valid')).toHaveText('1');
    await expect(page.getByTestId('catalog-import-skipped')).toHaveText('2');
    await expect(page.getByTestId('catalog-import-duplicates')).toHaveText('1');

    // El modo por defecto es "Nombre y precio" y el producto no existe todavía.
    await expect(page.getByTestId('catalog-import-update-mode')).toHaveText('Nombre y precio');
    await expect(page.getByTestId('catalog-import-update-count')).toHaveText(
      'Se actualizarán 0 producto(s) existente(s)',
    );
    await expect(page.getByTestId('catalog-import-create-count')).toHaveText(
      'Se crearán 1 producto(s) nuevo(s)',
    );

    await expect(preview.getByText('El precio s/IVA no puede ser negativo')).toBeVisible();
    await expect(
      preview.getByText(
        `Código duplicado en el archivo: ${PREVIEW_PRODUCT_CODE} ya aparece en la fila 2`,
      ),
    ).toBeVisible();
    await expect(
      preview.getByRole('button', { name: 'Confirmar importación (1 registro)' }),
    ).toBeVisible();

    // Cambiar el modo descarta la vista previa calculada con el modo anterior.
    await page.getByRole('radio', { name: 'Solo nombre' }).check();
    await expect(page.getByTestId('catalog-import-preview')).toHaveCount(0);
    await expect(page.getByTestId('catalog-import-mode-help')).toContainText(
      'No crea productos nuevos',
    );

    // El dry-run no debe haber creado el producto válido.
    const products = await page.request.get(
      `/api/products?search=${encodeURIComponent(PREVIEW_PRODUCT_CODE)}&limit=10`,
    );
    expect(products.status()).toBe(200);
    const payload = (await products.json()) as { total: number; products: unknown[] };
    expect(payload.total).toBe(0);
    expect(payload.products).toHaveLength(0);
  });

  test('solo precio actualiza un producto existente y no crea códigos nuevos', async ({ page }) => {
    await loginAs(page, E2E_USERS.admin);

    const brandsResponse = await page.request.get('/api/brands');
    expect(brandsResponse.status()).toBe(200);
    const brandsPayload = (await brandsResponse.json()) as {
      brands: Array<{ _id: string; name: string }>;
    };
    const brand = brandsPayload.brands.find((candidate) => candidate.name === E2E_BRAND.name);
    expect(brand, `debe existir la marca ${E2E_BRAND.name}`).toBeTruthy();

    // Producto dedicado para no alterar los precios del resto de los E2E.
    const createResponse = await page.request.post('/api/products', {
      data: {
        brandId: brand!._id,
        code: PRICE_EXISTING_CODE,
        name: 'Producto E2E Solo Precio',
        price: 300,
      },
    });
    expect(createResponse.status()).toBe(200);

    await page.goto('/backoffice/import');
    await page.getByRole('radio', { name: 'Solo precio' }).check();

    const csv = [
      'Marca,Codigo,Precio',
      `${E2E_BRAND.name},${PRICE_EXISTING_CODE},987.65`,
      `${E2E_BRAND.name},${PRICE_NEW_CODE},50`,
    ].join('\n');

    await page.locator('#excel-file-input').setInputFiles({
      name: 'productos-solo-precio.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });

    const previewResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/catalog/import' &&
        response.request().method() === 'POST',
    );

    await page.getByRole('button', { name: 'Previsualizar y validar archivo' }).click();
    expect((await previewResponse).status()).toBe(200);

    const preview = page.getByTestId('catalog-import-preview');
    await expect(preview).toBeVisible();
    await expect(page.getByTestId('catalog-import-update-mode')).toHaveText('Solo precio');
    await expect(page.getByTestId('catalog-import-update-count')).toHaveText(
      'Se actualizarán 1 producto(s) existente(s)',
    );
    await expect(page.getByTestId('catalog-import-create-count')).toHaveText(
      'No se crearán productos nuevos',
    );
    await expect(preview.getByText('No encontrado')).toBeVisible();

    const confirmResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/catalog/import' &&
        response.request().method() === 'POST',
    );

    await page.getByRole('button', { name: 'Confirmar importación (1 registro)' }).click();
    const confirmResponse = await confirmResponsePromise;
    expect(confirmResponse.status()).toBe(200);
    const confirmPayload = (await confirmResponse.json()) as {
      updateMode: string;
      updated: number;
      created: number;
    };
    expect(confirmPayload.updateMode).toBe('price');
    expect(confirmPayload.updated).toBe(1);
    expect(confirmPayload.created).toBe(0);

    // El producto existente conserva el nombre y recibe el precio nuevo.
    const existingResponse = await page.request.get(
      `/api/products?search=${encodeURIComponent(PRICE_EXISTING_CODE)}&limit=10`,
    );
    expect(existingResponse.status()).toBe(200);
    const existingPayload = (await existingResponse.json()) as {
      products: Array<{ code: string; name: string; price: number }>;
    };
    const existingProduct = existingPayload.products.find(
      (product) => product.code === PRICE_EXISTING_CODE,
    );
    expect(existingProduct?.name).toBe('Producto E2E Solo Precio');
    expect(Number(existingProduct?.price)).toBe(987.65);

    // El código inexistente no se crea en modo "Solo precio".
    const newResponse = await page.request.get(
      `/api/products?search=${encodeURIComponent(PRICE_NEW_CODE)}&limit=10`,
    );
    expect(newResponse.status()).toBe(200);
    const newPayload = (await newResponse.json()) as { total: number; products: unknown[] };
    expect(newPayload.total).toBe(0);
    expect(newPayload.products).toHaveLength(0);
  });
});
