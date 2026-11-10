import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  buildBrandSearchFields,
  buildClientSearchFields,
  buildOrderSearchFields,
  buildProductSearchFields,
} from '../lib/search-normalize';
import {
  buildBrandSearchFilter,
  buildClientSearchFilter,
  buildProductSearchFilter,
} from '../lib/search-query';
import { buildOrderListQuery } from '../lib/order-query';
import { orderShortId } from '../lib/order-short-id';

/**
 * Medición reproducible con `explain('executionStats')` de los buscadores.
 *
 * Levanta MongoDB en memoria, genera `EXPLAIN_DOCS` documentos (30.000 por
 * defecto) para clientes, productos y pedidos, y compara el camino anterior
 * (regex `i` no anclado + $text) contra el actual (prefijo normalizado +
 * índices B-tree). No toca la base configurada en MONGODB_URI.
 *
 * Uso:
 *   npm run search:explain
 *   EXPLAIN_DOCS=50000 npm run search:explain
 */

const TOTAL = Math.max(1000, Number(process.env.EXPLAIN_DOCS) || 30_000);
const LIMIT = 50;

type Stats = {
  plan: string;
  keys: number;
  docs: number;
  returned: number;
  ms: number;
};

function summarizePlan(node: any): string {
  const stages: string[] = [];
  const walk = (current: any) => {
    if (!current) return;
    if (current.stage) stages.push(current.stage);
    if (current.indexName) stages.push(`[${current.indexName}]`);
    if (current.inputStage) walk(current.inputStage);
    if (current.inputStages) current.inputStages.forEach(walk);
  };
  walk(node);
  return stages.join(' -> ');
}

function statsOf(explain: any): Stats {
  const execution = explain.executionStats;
  return {
    plan: summarizePlan(explain.queryPlanner.winningPlan),
    keys: execution.totalKeysExamined,
    docs: execution.totalDocsExamined,
    returned: execution.nReturned,
    ms: execution.executionTimeMillis,
  };
}

async function measure(
  collection: any,
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
): Promise<{ find: Stats; count: Stats }> {
  const find = await collection.find(filter).sort(sort).limit(LIMIT).explain('executionStats');
  const count = await collection.db.command({
    explain: { count: collection.collectionName, query: filter },
    verbosity: 'executionStats',
  });
  return { find: statsOf(find), count: statsOf(count) };
}

function row(label: string, result: { find: Stats; count: Stats }): string {
  const { find, count } = result;
  return (
    `| ${label} | \`${find.plan}\` | ${find.keys} / ${find.docs} / ${find.returned} | ${find.ms} ms | ` +
    `${count.keys} / ${count.docs} | ${count.ms} ms |`
  );
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('sgi-search-explain'));
  const db = mongoose.connection.db!;
  const brands = db.collection('brands');
  const clients = db.collection('clients');
  const products = db.collection('products');
  const orders = db.collection('orders');

  console.log(`Generando ${TOTAL.toLocaleString('es-AR')} documentos por colección...`);

  const brandDocs = Array.from({ length: 200 }, (_, index) => {
    const name = index === 0 ? 'Gómez Labs' : `Marca ${index}`;
    return {
      _id: new mongoose.Types.ObjectId(),
      name,
      codePrefix: `M${index}`,
      ...buildBrandSearchFields({ name }),
    };
  });
  await brands.insertMany(brandDocs);

  const clientDocs = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const name =
      index % 500 === 0
        ? `Gómez Cliente ${index}`
        : index % 7 === 0
          ? `Cliente Núñez ${index}`
          : `Cliente ${index}`;
    const code = index % 1000 === 0 ? `MOD-${index}` : `C-${index}`;
    const localidad = index % 11 === 0 ? 'Rosario' : `Ciudad ${index % 100}`;
    const province = index % 13 === 0 ? 'Santa Fe' : `Provincia ${index % 20}`;
    const address = index % 17 === 0 ? 'Calle Falsa 123' : `Calle ${index}`;
    clientDocs.push({
      code,
      name,
      localidad,
      province,
      address,
      ...buildClientSearchFields({ code, name, localidad, province, address }),
    });
  }
  await clients.insertMany(clientDocs);

  const productDocs = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const name = index % 500 === 0 ? `Gómez Producto ${index}` : `Producto ${index}`;
    const code = index % 1000 === 0 ? `MOD-${index}` : `P-${index}`;
    const brand = brandDocs[index % brandDocs.length];
    productDocs.push({
      brandId: brand._id,
      code,
      name,
      active: index % 97 !== 0,
      price: index,
      ...buildProductSearchFields({ code, name, brandName: brand.name }),
    });
  }
  await products.insertMany(productDocs);

  const orderDocs = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const clientName = index % 500 === 0 ? `Gómez Cliente ${index}` : `Cliente ${index}`;
    const clientCode = index % 1000 === 0 ? `MOD-${index}` : `C-${index}`;
    const createdBy = index % 19 === 0 ? 'vendedor-gomez' : `vendedor${index % 8}`;
    const createdAt = new Date(Date.now() - index * 1000);
    const _id = new mongoose.Types.ObjectId();
    const shortId = orderShortId(_id);
    const items =
      index % 3 === 0
        ? [
            {
              productId: new mongoose.Types.ObjectId(),
              productCode: 'SH-400',
              productName: 'Shampoo NovaFarma 400ml',
              brandName: 'Gómez Labs',
            },
          ]
        : [];

    orderDocs.push({
      _id,
      clientId: new mongoose.Types.ObjectId(),
      clientName,
      clientCode,
      shortId,
      status: index % 5 === 0 ? 'facturacion' : 'borrador',
      finalTotal: index,
      createdBy,
      archived: false,
      createdAt,
      updatedAt: createdAt,
      items,
      ...buildOrderSearchFields({ clientName, clientCode, createdBy, shortId, items }),
    });
  }
  await orders.insertMany(orderDocs);

  // Índices previos al cambio.
  await brands.createIndex({ name: 1 }, { unique: true });
  await clients.createIndex({ code: 1 }, { unique: true });
  await clients.createIndex({ name: 1, _id: 1 });
  await products.createIndex({ brandId: 1, code: 1 }, { unique: true });
  await products.createIndex({ brandId: 1, name: 1, active: 1 });
  await products.createIndex({ name: 1, active: 1 });
  await orders.createIndex({ status: 1, createdAt: -1, _id: -1 });
  await orders.createIndex({ archived: 1, createdAt: -1, _id: -1 });
  await orders.createIndex(
    { clientName: 'text', clientCode: 'text', createdBy: 'text' },
    { name: 'order_search_text', default_language: 'spanish' },
  );

  const legacyClientFilter = {
    $or: [
      { code: /Gómez/i },
      { name: /Gómez/i },
      { localidad: /Gómez/i },
      { province: /Gómez/i },
      { address: /Gómez/i },
    ],
  };
  const legacyBrandIds = (await brands.find({ name: /Gómez/i }).project({ _id: 1 }).toArray()).map(
    (brand) => brand._id,
  );
  const legacyProductFilter = {
    active: { $ne: false },
    $or: [{ name: /Gómez/i }, { code: /Gómez/i }, { brandId: { $in: legacyBrandIds } }],
  };
  const legacyOrderFilter = { archived: false, $text: { $search: 'Gómez*' } };

  console.log('\n### Antes\n');
  console.log(
    '| Consulta | Plan (find) | keys / docs / devueltos | find | count keys / docs | count |',
  );
  console.log('| --- | --- | --- | --- | --- | --- |');
  const beforeClient = await measure(clients, legacyClientFilter, { name: 1, _id: 1 });
  const beforeProduct = await measure(products, legacyProductFilter, { name: 1 });
  const beforeOrder = await measure(orders, legacyOrderFilter, { createdAt: -1, _id: -1 });
  console.log(row('Clientes search=Gómez (regex i no anclado)', beforeClient));
  console.log(row('Productos search=Gómez (regex i + marca)', beforeProduct));
  console.log(row('Pedidos search=Gómez ($text + sort createdAt)', beforeOrder));

  // Índices nuevos: mismos documentos, consultas por tokens normalizados.
  await clients.createIndex({ searchName: 1 });
  await clients.createIndex({ searchCode: 1 });
  await clients.createIndex({ searchLocalidad: 1 });
  await clients.createIndex({ searchProvince: 1 });
  await clients.createIndex({ searchAddress: 1 });
  await clients.createIndex({ searchTokens: 1 });
  await brands.createIndex({ searchName: 1 });
  await products.createIndex({ searchName: 1, active: 1 });
  await products.createIndex({ searchCode: 1, active: 1 });
  await products.createIndex({ searchTokens: 1, active: 1 });
  // Reemplaza el índice de texto: prefijo multikey + orden del cursor.
  await orders.createIndex({ archived: 1, searchTokens: 1, createdAt: -1, _id: -1 });

  const newBrands = await brands
    .find(buildBrandSearchFilter('Gómez')!)
    .project({ _id: 1, name: 1 })
    .toArray();
  const newClientFilter = buildClientSearchFilter('Gómez')!;
  const newProductFilter = buildProductSearchFilter('Gómez', newBrands)!;
  const newOrderQuery = buildOrderListQuery(
    { userId: '0000000000000000000000a1', username: 'admin', role: 'admin' },
    { archived: 'false', search: 'Gómez' },
  );
  const newOrderFilter = newOrderQuery.ok ? newOrderQuery.query : legacyOrderFilter;

  console.log('\n### Después\n');
  console.log(
    '| Consulta | Plan (find) | keys / docs / devueltos | find | count keys / docs | count |',
  );
  console.log('| --- | --- | --- | --- | --- | --- |');
  const afterClient = await measure(clients, newClientFilter, { name: 1, _id: 1 });
  const afterProduct = await measure(products, newProductFilter, { name: 1 });
  const afterOrder = await measure(orders, newOrderFilter, { createdAt: -1, _id: -1 });
  console.log(row('Clientes search=Gómez (tokens indexados)', afterClient));
  console.log(row('Productos search=Gómez (tokens indexados)', afterProduct));
  console.log(row('Pedidos search=Gómez (tokens indexados)', afterOrder));

  console.log('\nPedidos reemplaza `order_search_text` por el multikey `searchTokens`; el índice');
  console.log('compuesto mantiene filtro por archivado + orden por createdAt/_id.');

  await mongoose.disconnect();
  await mongo.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
