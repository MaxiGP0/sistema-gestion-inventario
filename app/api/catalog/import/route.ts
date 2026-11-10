import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { requireCurrentRole } from '@/lib/auth';
import { Brand } from '@/models/Brand';
import { Product } from '@/models/Product';
import { Client } from '@/models/Client';
import { catalogImportSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, zodErrorResponse } from '@/lib/api-errors';
import {
  API_RATE_LIMIT_RULES,
  apiRateLimitKey,
  consume,
  rateLimitResponse,
} from '@/lib/api-rate-limit';
import { revalidateCatalog } from '@/lib/catalog-cache';
import type {
  CatalogImportPreviewResponse,
  CatalogImportResponse,
  CatalogImportRowError,
  CatalogImportType,
  CatalogImportUpdateMode,
} from '@/lib/types';
import {
  buildBrandSearchFields,
  buildClientSearchFields,
  buildProductSearchFields,
} from '@/lib/search-normalize';
import {
  MAX_FILE_BYTES,
  MAX_REPORTED_ERRORS,
  MAX_ROWS,
  buildClientImportPlan,
  buildProductImportPlan,
  extractProductImportKeys,
  normalizeBrandName,
  parseWorkbookRows,
  productImportKey,
  type ClientImportRow,
  type ImportPlan,
  type ImportRow,
  type ImportRowIssue,
  type ProductImportKey,
  type ProductImportRow,
} from '@/lib/catalog-import';
import { withRouteLogging } from '@/lib/logger';

const BULK_CHUNK_SIZE = 500;

type BrandDocument = { _id: any; name: string };
type ProductKeyDocument = { brandId: any; code: string };

/** Acepta `?dryRun=1`, `?preview=true` o los mismos campos en el FormData. */
function isDryRunFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'on', 'yes', 'si', 'sí'].includes(value.trim().toLowerCase());
}

/** Índice de marcas existentes por clave normalizada (DERMAPLUS = DermaPlus). */
async function loadBrandIndex(): Promise<Map<string, BrandDocument>> {
  const brands = (await Brand.find({}, { name: 1 }).lean()) as unknown as BrandDocument[];
  const byKey = new Map<string, BrandDocument>();

  for (const brand of brands) {
    const key = normalizeBrandName(brand.name);
    // Si ya había duplicados históricos (DermaPlus + DERMAPLUS), se usa el primero.
    if (!byKey.has(key)) byKey.set(key, brand);
  }

  return byKey;
}

/**
 * Claves marca normalizada + código de los productos que ya existen.
 *
 * Solo se consultan las claves extraídas del archivo (en lotes de 500) para no
 * cargar todo el catálogo. Las marcas que todavía no existen no pueden tener
 * productos: simplemente no aportan claves y quedan como altas en modo `both`.
 */
async function loadExistingProductKeys(
  keys: ProductImportKey[],
  brands: Map<string, BrandDocument>,
): Promise<Set<string>> {
  const brandKeyById = new Map<string, string>();
  for (const [brandName, brand] of brands) {
    brandKeyById.set(String(brand._id), brandName);
  }

  const pairs: Array<{ brandId: any; code: string }> = [];
  for (const key of keys) {
    const brand = brands.get(key.brandName);
    if (brand) pairs.push({ brandId: brand._id, code: key.code });
  }

  const existing = new Set<string>();
  for (let i = 0; i < pairs.length; i += BULK_CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + BULK_CHUNK_SIZE);
    const products = (await Product.find(
      { $or: chunk },
      { brandId: 1, code: 1 },
    ).lean()) as unknown as ProductKeyDocument[];

    for (const product of products) {
      const brandName = brandKeyById.get(String(product.brandId));
      if (brandName) existing.add(productImportKey(brandName, String(product.code)));
    }
  }

  return existing;
}

/** Marcas del archivo que todavía no existen en la base. */
function findMissingBrands(
  plan: ImportPlan<ProductImportRow>,
  brands: Map<string, BrandDocument>,
): string[] {
  const missing = new Set<string>();
  for (const product of plan.rows) {
    if (!brands.has(product.brandName)) missing.add(product.brandName);
  }
  return [...missing];
}

/**
 * Crea las marcas faltantes con el nombre ya normalizado y recarga el índice.
 * Una segunda lectura normalizada evita duplicar "DERMAPLUS" si otra petición creó
 * "DermaPlus" en paralelo (el índice unique de Mongo es case-sensitive).
 */
async function createMissingBrands(
  names: string[],
  brands: Map<string, BrandDocument>,
): Promise<void> {
  if (names.length === 0) return;

  await Brand.insertMany(
    names.map((name) => ({ name, ...buildBrandSearchFields({ name }) })),
    { ordered: false },
  ).catch(() => {
    // Ignora duplicados (nombre unique); el reencuentro de abajo recupera las válidas.
  });

  const refreshed = await loadBrandIndex();
  for (const [key, brand] of refreshed) brands.set(key, brand);
}

function previewRowErrors(issues: ImportRowIssue[]): {
  errors: CatalogImportRowError[];
  errorCount: number;
  errorsTruncated: boolean;
} {
  const errors = issues.slice(0, MAX_REPORTED_ERRORS);
  return {
    errors,
    errorCount: issues.length,
    errorsTruncated: issues.length > errors.length,
  };
}

interface ProductPreviewSummary {
  updateMode: CatalogImportUpdateMode;
  updateCount: number;
  createCount: number;
}

/** Respuesta común del modo dry-run: mismo plan, sin escribir nada. */
function buildPreviewResponse<T>(
  type: CatalogImportType,
  plan: ImportPlan<T>,
  newBrands: string[],
  productSummary?: ProductPreviewSummary,
): NextResponse {
  const skipped = plan.total - plan.rows.length;
  const { errors, errorCount, errorsTruncated } = previewRowErrors(plan.errors);
  const countsMessage = productSummary
    ? ` (${productSummary.updateCount} actualización(es), ${productSummary.createCount} alta(s))`
    : '';

  const response: CatalogImportPreviewResponse = {
    success: true,
    dryRun: true,
    type,
    total: plan.total,
    valid: plan.rows.length,
    skipped,
    duplicates: plan.duplicateCount,
    errorCount,
    errors,
    errorsTruncated,
    newBrands,
    ...(productSummary ?? {}),
    message:
      `Vista previa: ${plan.rows.length} de ${plan.total} fila(s) válida(s)${countsMessage}, ` +
      `${skipped} omitida(s). No se escribió nada.`,
  };

  return NextResponse.json(response);
}

interface ProductUpsertResult {
  updated: number;
  created: number;
}

/**
 * Upsert masivo de productos ya validados, resolviendo la marca por su clave.
 *
 * `$setOnInsert` solo se aplica al crear: un producto existente nunca se
 * reactiva ni se le pisa la imagen. Los modos de un solo campo no insertan
 * porque el plan ya descartó las filas inexistentes.
 */
async function upsertProducts(
  rows: ProductImportRow[],
  brands: Map<string, BrandDocument>,
  updateMode: CatalogImportUpdateMode,
): Promise<ProductUpsertResult> {
  const operations = rows.flatMap((product) => {
    const brand = brands.get(product.brandName);
    if (!brand) return [];

    const selectedFields: Record<string, unknown> = {};
    if (updateMode === 'both' || updateMode === 'name') {
      selectedFields.name = product.name;
      // bulkWrite no ejecuta los hooks del schema: las claves de búsqueda y el
      // array de tokens (código, nombre y marca) se recalculan cuando cambia el
      // nombre. En modo precio no se tocan.
      Object.assign(
        selectedFields,
        buildProductSearchFields({ ...product, brandName: brand.name }),
      );
    }
    if (updateMode === 'both' || updateMode === 'price') {
      selectedFields.price = product.price;
      selectedFields.priceWithIva = product.priceWithIva;
    }

    const setOnInsert: Record<string, unknown> = { active: true };
    if (product.imageUrl) setOnInsert.imageUrl = product.imageUrl;

    return [
      {
        updateOne: {
          filter: { brandId: brand._id, code: product.code },
          update: {
            $set: {
              brandId: brand._id,
              code: product.code,
              ...selectedFields,
            },
            $setOnInsert: setOnInsert,
          },
          upsert: updateMode === 'both',
        },
      },
    ];
  });

  let updated = 0;
  let created = 0;
  for (let i = 0; i < operations.length; i += BULK_CHUNK_SIZE) {
    const chunk = operations.slice(i, i + BULK_CHUNK_SIZE);
    const result = await Product.bulkWrite(chunk, { ordered: false });
    updated += result.matchedCount || 0;
    created += result.upsertedCount || 0;
  }

  return { updated, created };
}

/** Upsert masivo de clientes ya validados. */
async function upsertClients(rows: ClientImportRow[]): Promise<number> {
  const operations = rows.map((client) => ({
    updateOne: {
      filter: { code: client.code },
      update: {
        $set: {
          code: client.code,
          name: client.name,
          address: client.address,
          localidad: client.localidad,
          province: client.province,
          generalDiscount: client.generalDiscount,
          ...buildClientSearchFields(client),
        },
      },
      upsert: true,
    },
  }));

  let importedCount = 0;
  for (let i = 0; i < operations.length; i += BULK_CHUNK_SIZE) {
    const chunk = operations.slice(i, i + BULK_CHUNK_SIZE);
    const result = await Client.bulkWrite(chunk, { ordered: false });
    importedCount += (result.matchedCount || 0) + (result.upsertedCount || 0);
  }

  return importedCount;
}

function noRowsImportedResponse(data: ImportRow[]): NextResponse {
  const sampleKeys = Object.keys(data[0]?.values ?? {}).join(', ');
  return errorResponse(
    `No se pudo importar ningún registro. Asegúrate de que las columnas coincidan. Columnas detectadas en el archivo: [ ${sampleKeys} ]`,
    400,
  );
}

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const auth = await requireCurrentRole(request, ['admin']);
    if ('response' in auth) return auth.response;

    // La importación lee hasta 5 MB / 5.000 filas: se corta por usuario antes
    // de parsear el archivo o tocar la base.
    const limitResult = consume(
      apiRateLimitKey('catalog-import', auth.session.userId),
      API_RATE_LIMIT_RULES.catalogImport,
    );
    if (!limitResult.allowed) return rateLimitResponse(limitResult);

    await dbConnect();

    // Corte temprano por tamaño antes de materializar el archivo en memoria.
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES + 1024 * 1024) {
      return errorResponse(
        `El archivo supera el límite de ${MAX_FILE_BYTES / (1024 * 1024)} MB`,
        400,
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('El cuerpo de la petición no es un FormData válido', 400);
    }

    const parsedBody = catalogImportSchema.safeParse({
      file: formData.get('file'),
      type: formData.get('type'),
      updateMode: formData.get('updateMode'),
    });
    if (!parsedBody.success) {
      return zodErrorResponse(parsedBody.error);
    }

    const { file, type, updateMode } = parsedBody.data;
    const { searchParams } = new URL(request.url);
    const dryRun =
      isDryRunFlag(searchParams.get('dryRun')) ||
      isDryRunFlag(searchParams.get('preview')) ||
      isDryRunFlag(formData.get('dryRun')) ||
      isDryRunFlag(formData.get('preview'));

    if (file.size > MAX_FILE_BYTES) {
      return errorResponse(
        `El archivo supera el límite de ${MAX_FILE_BYTES / (1024 * 1024)} MB`,
        400,
      );
    }

    const lowerFilename = file.name.toLowerCase();
    const isCsv = lowerFilename.endsWith('.csv');
    if (!isCsv && !lowerFilename.endsWith('.xlsx')) {
      return errorResponse('Formato no soportado. Subí un archivo .xlsx o .csv', 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const { rows: data, exceedsRowLimit } = await parseWorkbookRows(arrayBuffer, file.name);

    if (exceedsRowLimit) {
      return errorResponse(`El archivo supera el límite de ${MAX_ROWS} filas`, 400);
    }

    if (data.length === 0) {
      return errorResponse('El archivo Excel está vacío', 400);
    }

    if (type === 'products') {
      const brands = await loadBrandIndex();
      // Solo se consultan los productos candidatos del archivo, en lotes de
      // 500. El modo price/name descarta las filas inexistentes en el plan.
      const existingKeys = await loadExistingProductKeys(extractProductImportKeys(data), brands);
      const plan = buildProductImportPlan(data, { updateMode, existingKeys });
      const missingBrands = updateMode === 'both' ? findMissingBrands(plan, brands) : [];
      const updateCount = plan.rows.filter((product) => product.exists).length;
      const createCount = plan.rows.length - updateCount;

      if (dryRun) {
        return buildPreviewResponse('products', plan, missingBrands, {
          updateMode,
          updateCount,
          createCount,
        });
      }

      await createMissingBrands(missingBrands, brands);
      const { updated, created } = await upsertProducts(plan.rows, brands, updateMode);
      const importedCount = updated + created;

      if (importedCount === 0) return noRowsImportedResponse(data);

      // La importación puede crear marcas y productos: invalida todo el
      // catálogo para que el backoffice vea los cambios al refrescar.
      revalidateCatalog('brands', 'products', 'clients');
      const skippedCount = data.length - importedCount;
      const skippedSuffix =
        skippedCount > 0
          ? ` (${skippedCount} fila(s) omitida(s) por datos incompletos o inválidos)`
          : '';
      const response: CatalogImportResponse = {
        success: true,
        message:
          `Importación exitosa de ${importedCount} registro(s) de productos: ` +
          `${updated} actualizado(s) y ${created} creado(s)${skippedSuffix}`,
        count: importedCount,
        skipped: skippedCount,
        updateMode,
        updated,
        created,
      };
      return NextResponse.json(response);
    }

    const plan = buildClientImportPlan(data);

    if (dryRun) {
      return buildPreviewResponse('clients', plan, []);
    }

    const importedCount = await upsertClients(plan.rows);

    if (importedCount === 0) return noRowsImportedResponse(data);

    // La importación puede crear clientes: invalida todo el catálogo para que
    // el backoffice vea los cambios al refrescar.
    revalidateCatalog('brands', 'products', 'clients');
    const skippedCount = data.length - importedCount;
    const skippedSuffix =
      skippedCount > 0
        ? ` (${skippedCount} fila(s) omitida(s) por datos incompletos o inválidos)`
        : '';
    const response: CatalogImportResponse = {
      success: true,
      message: `Importación exitosa de ${importedCount} registros de ${type}${skippedSuffix}`,
      count: importedCount,
      skipped: skippedCount,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return handleRouteError(error, {
      context: 'Error en importación:',
      duplicateMessages: {
        'brandId+code': 'Ya existe un producto con ese código para la marca seleccionada',
        code: 'Ya existe un cliente con ese código',
        name: 'Ya existe una marca con ese nombre',
      },
    });
  }
});
