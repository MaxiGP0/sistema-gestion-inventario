import { PassThrough, Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import dbConnect from '@/lib/mongodb';
import { requireSession } from '@/lib/auth';
import { Order } from '@/models/Order';
import { errorResponse, handleRouteError } from '@/lib/api-errors';
import { buildOrderListQuery } from '@/lib/order-query';
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_CSV_MIME,
  ORDER_EXPORT_MAX_ROWS,
  ORDER_EXPORT_XLSX_MIME,
  buildOrderExportCsvHeader,
  buildOrderExportFilename,
  buildOrderExportRow,
  isOrderExportFormat,
  serializeOrderExportCsvRow,
  type OrderExportFormat,
  type OrderExportOrderLike,
} from '@/lib/order-export';
import { logError, withRouteLogging } from '@/lib/logger';

const ORDER_EXPORT_SELECT =
  'clientId clientName clientCode status subtotal totalDiscount finalTotal createdBy createdAt ' +
  'invoiceType paymentCondition paymentConditionDetail items.productCode items.productName ' +
  'items.brandName items.unitPrice items.requestedQuantity items.verifiedQuantity ' +
  'items.itemDiscount items.lineTotal';

/** Lotes del cursor: evita traer la colección completa a memoria. */
const ORDER_EXPORT_BATCH_SIZE = 250;

type OrderCursor = AsyncIterable<OrderExportOrderLike>;

/**
 * Corta el cursor en el tope de filas incluso si el driver entregara más
 * documentos que el `limit` pedido (defensa en profundidad).
 */
async function* limitedOrders(source: OrderCursor): AsyncGenerator<OrderExportOrderLike> {
  let emitted = 0;

  for await (const order of source) {
    yield order;
    emitted += 1;
    if (emitted >= ORDER_EXPORT_MAX_ROWS) break;
  }
}

function createCsvStream(cursor: OrderCursor): ReadableStream<Uint8Array> {
  const rows = (async function* () {
    yield Buffer.from(`${buildOrderExportCsvHeader()}\r\n`, 'utf8');

    for await (const order of limitedOrders(cursor)) {
      yield Buffer.from(`${serializeOrderExportCsvRow(buildOrderExportRow(order))}\r\n`, 'utf8');
    }
  })();

  return Readable.toWeb(Readable.from(rows)) as unknown as ReadableStream<Uint8Array>;
}

function createXlsxStream(cursor: OrderCursor): ReadableStream<Uint8Array> {
  const output = new PassThrough();

  void (async () => {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: output,
      useStyles: true,
      useSharedStrings: false,
    });
    const worksheet = workbook.addWorksheet('Pedidos');

    worksheet.columns = ORDER_EXPORT_COLUMNS.map((column) => ({ width: column.width }));

    const headerRow = worksheet.addRow(ORDER_EXPORT_COLUMNS.map((column) => column.header));
    headerRow.font = { bold: true };
    headerRow.commit();

    for await (const order of limitedOrders(cursor)) {
      const row = worksheet.addRow(buildOrderExportRow(order));
      // El detalle de líneas es multilínea: Excel debe mostrar el salto.
      row.getCell(ORDER_EXPORT_COLUMNS.length).alignment = {
        wrapText: true,
        vertical: 'top',
      };
      row.commit();
    }

    worksheet.commit();
    await workbook.commit();
  })().catch((error: unknown) => {
    logError('Error al generar la exportación XLSX de pedidos:', error);
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  return Readable.toWeb(output) as unknown as ReadableStream<Uint8Array>;
}

function exportHeaders(format: OrderExportFormat, filename: string): HeadersInit {
  return {
    'Content-Type': format === 'csv' ? ORDER_EXPORT_CSV_MIME : ORDER_EXPORT_XLSX_MIME,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  };
}

/**
 * GET /api/orders/export?format=csv|xlsx
 *
 * Usa los mismos filtros y permisos que GET /api/orders. La respuesta se
 * transmite por streaming: el cursor de Mongo se consume de a lotes y CSV/XLSX
 * se escriben a medida que llegan los pedidos, sin materializar las 10.000
 * filas en un array.
 */
export const GET = withRouteLogging(async (request: Request) => {
  try {
    const auth = requireSession(request);
    if ('response' in auth) return auth.response;

    const { searchParams } = new URL(request.url);
    const requestedFormat = (searchParams.get('format') ?? 'csv').toLowerCase();
    if (!isOrderExportFormat(requestedFormat)) {
      return errorResponse('El formato debe ser csv o xlsx', 400);
    }

    const filterResult = buildOrderListQuery(auth.session, {
      status: searchParams.get('status'),
      archived: searchParams.get('archived'),
      search: searchParams.get('search'),
      startDate: searchParams.get('startDate'),
      endDate: searchParams.get('endDate'),
      clientId: searchParams.get('clientId'),
    });
    if (!filterResult.ok) {
      return errorResponse(filterResult.error, 400);
    }

    await dbConnect();

    const cursor = Order.find(filterResult.query)
      .select(ORDER_EXPORT_SELECT)
      .populate({ path: 'clientId', select: 'code name' })
      .sort({ createdAt: -1, _id: -1 })
      .limit(ORDER_EXPORT_MAX_ROWS)
      .lean()
      .cursor({ batchSize: ORDER_EXPORT_BATCH_SIZE }) as unknown as OrderCursor;

    const filename = buildOrderExportFilename(requestedFormat);
    const body = requestedFormat === 'csv' ? createCsvStream(cursor) : createXlsxStream(cursor);

    return new Response(body, {
      headers: exportHeaders(requestedFormat, filename),
    });
  } catch (error: unknown) {
    return handleRouteError(error, { context: 'Error al exportar pedidos:' });
  }
});
