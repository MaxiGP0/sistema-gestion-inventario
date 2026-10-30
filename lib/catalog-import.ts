/**
 * Parseo y validación del import masivo de catálogo (.xlsx / .csv).
 *
 * El route handler y los tests comparten este módulo para que la vista previa
 * (dry-run) y la importación real validen exactamente igual. No toca la base de
 * datos: recibe las filas ya leídas de ExcelJS y devuelve las filas válidas más
 * los errores por fila (incluidos los duplicados dentro del archivo). El upsert
 * del route persiste las claves `search*` y el array multikey `searchTokens`.
 */

import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { CatalogImportUpdateMode } from './types/catalog';

/** Límites defensivos del import: tamaño de archivo y filas a procesar. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_ROWS = 5000;
/** Tope de errores que devuelve la vista previa (el resto se cuenta igual). */
export const MAX_REPORTED_ERRORS = 50;

/** Fila del archivo con sus valores crudos y el número de fila de Excel. */
export interface ImportRow {
  /** Número de fila del archivo; el encabezado es la fila 1. */
  row: number;
  values: Record<string, unknown>;
}

export interface ParsedRows {
  rows: ImportRow[];
  /** true si hay al menos una fila con datos por encima de MAX_ROWS. */
  exceedsRowLimit: boolean;
}

export type ImportIssueKind = 'validation' | 'duplicate' | 'not_found';

export interface ImportRowIssue {
  row: number;
  field?: string;
  reason: string;
  kind: ImportIssueKind;
}

export interface ImportPlan<T> {
  total: number;
  /** Filas únicas y válidas que se importarían. */
  rows: T[];
  /** Errores de validación y filas duplicadas, ordenados por fila. */
  errors: ImportRowIssue[];
  /** Cantidad de filas descartadas por repetir una clave dentro del archivo. */
  duplicateCount: number;
}

export interface ProductImportRow {
  row: number;
  /** Nombre normalizado (trim, mayúsculas y sin acentos). */
  brandName: string;
  code: string;
  name: string;
  price: number;
  priceWithIva: number;
  imageUrl: string;
  /** true si el producto ya existe (marca normalizada + código). */
  exists: boolean;
}

/** Clave normalizada de un producto en el archivo: marca + código. */
export interface ProductImportKey {
  brandName: string;
  code: string;
}

/** Clave canónica usada para comparar productos del archivo con la base. */
export function productImportKey(brandName: string, code: string): string {
  return `${brandName}\u0000${code}`;
}

/**
 * Extrae las claves marca normalizada + código del archivo, sin validar el
 * resto de las columnas. El route las usa para consultar solo los productos
 * candidatos en vez de cargar todo el catálogo.
 */
export function extractProductImportKeys(rows: ImportRow[]): ProductImportKey[] {
  const keys = new Map<string, ProductImportKey>();

  for (const { values } of rows) {
    const normalized = normalizeRow(values);
    const brandName = normalizeBrandName(firstValue(normalized, ['marca', 'brand']));
    const code = asText(firstValue(normalized, ['codigo', 'cod', 'code']));
    if (!code) continue;

    const key = productImportKey(brandName, code);
    if (!keys.has(key)) keys.set(key, { brandName, code });
  }

  return [...keys.values()];
}

export interface ClientImportRow {
  row: number;
  code: string;
  name: string;
  address: string;
  localidad: string;
  province: string;
  generalDiscount: number;
}

/** Convierte el valor crudo de una celda de ExcelJS a un primitivo usable. */
function cellToPrimitive(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((part) => part.text ?? '').join('');
    if ('result' in value) return cellToPrimitive(value.result as ExcelJS.CellValue);
    if ('text' in value) return value.text;
    if ('error' in value) return '';
    return String(value);
  }
  return value;
}

/** Arma las filas { encabezado: valor } de la primera hoja, cortando al superar MAX_ROWS. */
function rowsFromWorksheet(worksheet: ExcelJS.Worksheet | undefined): ParsedRows {
  const rows: ImportRow[] = [];
  if (!worksheet) return { rows, exceedsRowLimit: false };

  const headerByColumn = new Map<number, string>();
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = String(cellToPrimitive(cell.value) ?? '').trim();
    if (header) headerByColumn.set(colNumber, header);
  });

  if (headerByColumn.size === 0) return { rows, exceedsRowLimit: false };

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values: Record<string, unknown> = {};
    let hasValue = false;

    headerByColumn.forEach((header, colNumber) => {
      const value = cellToPrimitive(row.getCell(colNumber).value);
      if (value !== '' && value !== null && value !== undefined) hasValue = true;
      values[header] = value;
    });

    if (!hasValue) continue;

    // Se detecta la fila 5001 con datos y se corta: nunca se importa un archivo
    // parcialmente, el handler responde 400 con el límite.
    if (rows.length >= MAX_ROWS) return { rows, exceedsRowLimit: true };
    rows.push({ row: rowNumber, values });
  }

  return { rows, exceedsRowLimit: false };
}

/** Lee un .xlsx/.csv en memoria y devuelve sus filas como objetos. */
export async function parseWorkbookRows(
  arrayBuffer: ArrayBuffer,
  filename: string,
): Promise<ParsedRows> {
  const workbook = new ExcelJS.Workbook();

  if (filename.toLowerCase().endsWith('.csv')) {
    await workbook.csv.read(Readable.from(Buffer.from(arrayBuffer)));
  } else {
    await workbook.xlsx.load(arrayBuffer);
  }

  return rowsFromWorksheet(workbook.worksheets[0]);
}

/** Encabezados tolerantes a mayúsculas, acentos y espacios. */
export function normalizeRow(values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const cleanKey = key
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    normalized[cleanKey] = value;
  }
  return normalized;
}

/**
 * Clave canónica de una marca: trim, mayúsculas, sin acentos y con espacios
 * colapsados. " Bagó " y "BAGO" resuelven a la misma marca existente.
 */
export function normalizeBrandName(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  const base = trimmed || 'General';
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/** Primer alias con contenido; evita que un 0 o un string vacío corte la cadena. */
function firstValue(values: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

function asText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Convierte números de Excel o texto ("$ 1.234,56", "10 %") a número.
 * Devuelve `null` cuando el valor no es numérico y 0 cuando está vacío.
 */
function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value instanceof Date) return null;

  const raw = String(value).trim();
  if (!raw) return 0;

  const compact = raw.replace(/\s/g, '').replace(/^\$/, '').replace(/%$/, '');
  let normalized = compact;

  if (compact.includes(',') && compact.includes('.')) {
    // El último separador es el decimal: 1.234,56 / 1,234.56.
    normalized =
      compact.lastIndexOf(',') > compact.lastIndexOf('.')
        ? compact.replace(/\./g, '').replace(',', '.')
        : compact.replace(/,/g, '');
  } else if (compact.includes(',')) {
    normalized = compact.replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function validatePrice(
  raw: unknown,
  label: string,
  field: string,
  row: number,
  issues: ImportRowIssue[],
): number | null {
  const parsed = parseNumeric(raw);
  if (parsed === null) {
    issues.push({ row, field, kind: 'validation', reason: `${label} debe ser un número válido` });
    return null;
  }
  if (parsed < 0) {
    issues.push({ row, field, kind: 'validation', reason: `${label} no puede ser negativo` });
    return null;
  }
  return parsed;
}

export interface ProductImportPlanOptions {
  /** Campos a actualizar en productos existentes. Por defecto, nombre y precio. */
  updateMode?: CatalogImportUpdateMode;
  /** Claves `productImportKey` de los productos que ya existen en la base. */
  existingKeys?: ReadonlySet<string>;
}

const NO_EXISTING_KEYS: ReadonlySet<string> = new Set();

/**
 * Valida y deduplica las filas de productos del archivo.
 *
 * Es pura: no consulta Mongo. `existingKeys` lo calcula el route con una
 * consulta acotada por marca + código y se usa igual en el preview y en la
 * importación real para que ambos validen exactamente lo mismo.
 */
export function buildProductImportPlan(
  rows: ImportRow[],
  options: ProductImportPlanOptions = {},
): ImportPlan<ProductImportRow> {
  const updateMode = options.updateMode ?? 'both';
  const existingKeys = options.existingKeys ?? NO_EXISTING_KEYS;
  const errors: ImportRowIssue[] = [];
  const products: ProductImportRow[] = [];
  const firstRowByKey = new Map<string, number>();
  let duplicateCount = 0;

  for (const { row, values } of rows) {
    const normalized = normalizeRow(values);
    const brandName = normalizeBrandName(firstValue(normalized, ['marca', 'brand']));
    const code = asText(firstValue(normalized, ['codigo', 'cod', 'code']));
    const name = asText(firstValue(normalized, ['nombre', 'name', 'producto']));
    const key = productImportKey(brandName, code);
    const exists = Boolean(code) && existingKeys.has(key);

    const rowIssues: ImportRowIssue[] = [];
    if (!code) {
      rowIssues.push({
        row,
        field: 'codigo',
        kind: 'validation',
        reason: 'Falta el código del producto',
      });
    }
    // En modo precio el nombre se ignora por completo, incluso si falta.
    if (updateMode !== 'price' && !name) {
      rowIssues.push({
        row,
        field: 'nombre',
        kind: 'validation',
        reason: 'Falta el nombre del producto',
      });
    }

    let price = 0;
    let priceWithIva = 0;

    // En modo nombre los precios se ignoran por completo: no se parsean ni se
    // validan para que un valor inválido no bloquee la actualización del nombre.
    if (updateMode !== 'name') {
      const rawPriceSiva = firstValue(normalized, [
        'precio s/iva',
        'precio s iva',
        'precio',
        'price',
      ]);
      const rawPriceCiva = firstValue(normalized, [
        'precio c/iva',
        'precio con iva',
        'precio c iva',
        'price_with_iva',
      ]);
      // `firstValue` devuelve undefined para una columna ausente o una celda
      // vacía; un 0 explícito sí llega como número y es un precio válido.
      const hasPriceSiva = rawPriceSiva !== undefined;
      const hasPriceCiva = rawPriceCiva !== undefined;

      if (!hasPriceSiva && !hasPriceCiva) {
        rowIssues.push({
          row,
          field: 'precio_sin_iva',
          kind: 'validation',
          reason: 'Falta el precio del producto (Precio s/IVA o Precio c/IVA)',
        });
      } else {
        const priceSiva = hasPriceSiva
          ? validatePrice(rawPriceSiva, 'El precio s/IVA', 'precio_sin_iva', row, rowIssues)
          : null;
        const priceCiva = hasPriceCiva
          ? validatePrice(rawPriceCiva, 'El precio c/IVA', 'precio_con_iva', row, rowIssues)
          : null;

        if (priceSiva !== null && priceCiva !== null) {
          // Si vienen ambas columnas se respetan tal cual, incluso un 0.
          price = priceSiva;
          priceWithIva = priceCiva;
        } else if (priceSiva !== null) {
          price = priceSiva;
          priceWithIva = price > 0 ? Number((price * 1.21).toFixed(2)) : 0;
        } else if (priceCiva !== null) {
          priceWithIva = priceCiva;
          price = priceWithIva > 0 ? Number((priceWithIva / 1.21).toFixed(2)) : 0;
        }
      }
    }

    if (rowIssues.length > 0) {
      errors.push(...rowIssues);
      continue;
    }

    const firstRow = firstRowByKey.get(key);
    if (firstRow !== undefined) {
      duplicateCount += 1;
      errors.push({
        row,
        field: 'codigo',
        kind: 'duplicate',
        reason: `Código duplicado en el archivo: ${code} ya aparece en la fila ${firstRow}`,
      });
      continue;
    }
    firstRowByKey.set(key, row);

    // Los modos de un solo campo solo actualizan productos existentes y nunca
    // crean marcas ni productos nuevos.
    if (updateMode !== 'both' && !exists) {
      const modeLabel = updateMode === 'name' ? 'Solo nombre' : 'Solo precio';
      errors.push({
        row,
        field: 'codigo',
        kind: 'not_found',
        reason: `El producto no existe; el modo ${modeLabel} solo actualiza productos existentes.`,
      });
      continue;
    }

    products.push({
      row,
      brandName,
      code,
      name,
      price,
      priceWithIva,
      imageUrl: asText(firstValue(normalized, ['imagen', 'image', 'image_url'])),
      exists,
    });
  }

  errors.sort((a, b) => a.row - b.row);
  return { total: rows.length, rows: products, errors, duplicateCount };
}

/** Valida y deduplica las filas de clientes del archivo. */
export function buildClientImportPlan(rows: ImportRow[]): ImportPlan<ClientImportRow> {
  const errors: ImportRowIssue[] = [];
  const clients: ClientImportRow[] = [];
  const firstRowByCode = new Map<string, number>();
  let duplicateCount = 0;

  for (const { row, values } of rows) {
    const normalized = normalizeRow(values);
    const code = asText(firstValue(normalized, ['cod', 'codigo', 'code']));
    const name = asText(firstValue(normalized, ['razon social', 'nombre', 'name', 'cliente']));

    const rowIssues: ImportRowIssue[] = [];
    if (!code) {
      rowIssues.push({
        row,
        field: 'codigo',
        kind: 'validation',
        reason: 'Falta el código del cliente',
      });
    }
    if (!name) {
      rowIssues.push({
        row,
        field: 'nombre',
        kind: 'validation',
        reason: 'Falta el nombre del cliente',
      });
    }

    const discount = parseNumeric(
      firstValue(normalized, [
        'descuento general',
        'descuentogeneral',
        'descuento',
        'general_discount',
      ]),
    );
    if (discount === null) {
      rowIssues.push({
        row,
        field: 'descuento_general',
        kind: 'validation',
        reason: 'El descuento general debe ser un número válido',
      });
    } else if (discount < 0 || discount > 100) {
      rowIssues.push({
        row,
        field: 'descuento_general',
        kind: 'validation',
        reason: 'El descuento general debe estar entre 0 y 100',
      });
    }

    if (rowIssues.length > 0 || discount === null) {
      errors.push(...rowIssues);
      continue;
    }

    const firstRow = firstRowByCode.get(code);
    if (firstRow !== undefined) {
      duplicateCount += 1;
      errors.push({
        row,
        field: 'codigo',
        kind: 'duplicate',
        reason: `Código duplicado en el archivo: ${code} ya aparece en la fila ${firstRow}`,
      });
      continue;
    }
    firstRowByCode.set(code, row);

    clients.push({
      row,
      code,
      name,
      address: asText(firstValue(normalized, ['domicilio', 'direccion', 'address'])),
      localidad: asText(firstValue(normalized, ['localidad', 'ciudad', 'city'])),
      province: asText(firstValue(normalized, ['provincia', 'province'])),
      generalDiscount: discount,
    });
  }

  errors.sort((a, b) => a.row - b.row);
  return { total: rows.length, rows: clients, errors, duplicateCount };
}
