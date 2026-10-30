/**
 * Pruebas de la migración a `{ timestamps: true }` en Order/Client/Product/Brand.
 *
 * Antes, `updatedAt` sólo avanzaba en `save()` (por el pre('save') manual de
 * Order) y las escrituras por query (findByIdAndUpdate, findOneAndUpdate,
 * bulkWrite) lo dejaban viejo. Con `timestamps: true` Mongoose agrega
 * `updatedAt` a toda operación de update y `createdAt` en las altas
 * ($setOnInsert), cubriendo todas las rutas de escritura:
 *   - POST/PUT /api/orders      -> create() y save()
 *   - POST/PUT /api/clients     -> findOneAndUpdate(upsert) y findByIdAndUpdate
 *   - POST/PUT /api/products    -> findOneAndUpdate(upsert) y findByIdAndUpdate
 *   - POST/PUT /api/brands      -> create() y findByIdAndUpdate
 *   - POST /api/catalog/import  -> Product/Client.bulkWrite (upserts)
 *
 * No requiere base de datos: se interceptan los métodos del driver en
 * `Model.$__collection` y se deja correr el pipeline real de Mongoose (casting,
 * defaults, validaciones y hooks de timestamps) hasta la frontera con MongoDB;
 * el update que Mongoose habría enviado queda capturado para las aserciones.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Order } from '../models/Order';
import { Product } from '../models/Product';

const oid = () => new mongoose.Types.ObjectId();

const MODELS = [Order, Client, Product, Brand];

type CapturedWrite = { model: string; method: string; args: any[] };

const writes: CapturedWrite[] = [];

/** Reemplaza un método del driver por una captura; restaura con mock.restoreAll(). */
const stubCollectionMethod = (
  model: mongoose.Model<any>,
  method: string,
  result: (...args: any[]) => any,
) => {
  const collection = (model as any).$__collection;
  mock.method(collection, method, async (...args: any[]) => {
    writes.push({ model: model.modelName, method, args });
    return result(...args);
  });
};

/** Update que Mongoose envió al driver para el modelo (vacío si no hubo escritura). */
const updateFor = (modelName: string) =>
  writes.find((write) => write.model === modelName && write.method === 'findOneAndUpdate')?.args[1];

/** Verifica que el update enviado a Mongo lleva un updatedAt nuevo y no pisa createdAt. */
const assertFreshUpdatedAt = (update: any, label: string, start: number) => {
  const updatedAt = update?.$set?.updatedAt;
  assert.ok(updatedAt instanceof Date, `${label}: el update debe incluir $set.updatedAt`);
  assert.ok(
    updatedAt.getTime() >= start,
    `${label}: updatedAt debe ser posterior al inicio de la escritura`,
  );
  assert.equal(update.$set.createdAt, undefined, `${label}: updatedAt no debe pisar createdAt`);
};

before(() => {
  for (const model of MODELS) {
    stubCollectionMethod(model, 'findOneAndUpdate', () => null);
    stubCollectionMethod(model, 'updateOne', () => ({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    }));
    stubCollectionMethod(model, 'insertOne', (doc: any) => ({
      acknowledged: true,
      insertedId: doc._id,
    }));
    stubCollectionMethod(model, 'bulkWrite', () => ({
      ok: 1,
      acknowledged: true,
      insertedCount: 0,
      matchedCount: 1,
      modifiedCount: 1,
      deletedCount: 0,
      upsertedCount: 0,
      insertedIds: {},
      upsertedIds: {},
    }));
  }
});

after(() => mock.restoreAll());

test('los cuatro modelos declaran timestamps: true y Mongoose agrega createdAt/updatedAt', () => {
  for (const model of MODELS) {
    assert.equal(
      (model.schema as any).options.timestamps,
      true,
      `${model.modelName} debe usar timestamps: true`,
    );
    assert.ok(
      (model.schema as any).path('createdAt'),
      `${model.modelName}: el schema debe exponer createdAt`,
    );
    assert.ok(
      (model.schema as any).path('updatedAt'),
      `${model.modelName}: el schema debe exponer updatedAt`,
    );
  }
});

test('findByIdAndUpdate (PUT por id) agrega un updatedAt nuevo sin tocar createdAt', async () => {
  writes.length = 0;
  const start = Date.now();

  await Order.findByIdAndUpdate(oid(), { status: 'paralizado' }, { runValidators: true });
  await Client.findByIdAndUpdate(oid(), { name: 'Cliente Actualizado' }, { runValidators: true });
  await Product.findByIdAndUpdate(oid(), { name: 'Producto Actualizado' }, { runValidators: true });
  await Brand.findByIdAndUpdate(oid(), { name: 'Marca Actualizada' }, { runValidators: true });

  for (const model of MODELS) {
    assertFreshUpdatedAt(updateFor(model.modelName), model.modelName, start);
  }
});

test('el upsert de POST /api/clients y /api/products programa createdAt en el alta y actualiza updatedAt', async () => {
  writes.length = 0;
  const start = Date.now();
  const brandId = oid();

  await Client.findOneAndUpdate(
    { code: 'C1' },
    { code: 'C1', name: 'Cliente Importado' },
    { upsert: true, runValidators: true },
  );
  await Product.findOneAndUpdate(
    { brandId, code: 'P1' },
    { brandId, code: 'P1', name: 'Producto Importado', price: 10 },
    { upsert: true, runValidators: true },
  );

  for (const model of [Client, Product]) {
    const update = updateFor(model.modelName);
    assertFreshUpdatedAt(update, model.modelName, start);
    assert.ok(
      update?.$setOnInsert?.createdAt instanceof Date,
      `${model.modelName}: el alta con upsert debe programar createdAt en $setOnInsert`,
    );
  }
});

test('create() inicializa createdAt y updatedAt (POST /api/orders y /api/brands)', async () => {
  writes.length = 0;

  const order = await Order.create({ clientId: oid(), createdBy: 'vendedor' });
  const brand = await Brand.create({ name: 'Marca Nueva' });

  for (const modelName of ['Order', 'Brand']) {
    const insert = writes.find(
      (write) => write.model === modelName && write.method === 'insertOne',
    );
    assert.ok(insert, `${modelName}: el alta debe insertar`);
    assert.ok(
      insert.args[0].createdAt instanceof Date,
      `${modelName}: el insert debe persistir createdAt`,
    );
    assert.ok(
      insert.args[0].updatedAt instanceof Date,
      `${modelName}: el insert debe persistir updatedAt`,
    );
  }

  assert.ok(
    order.createdAt instanceof Date && order.updatedAt instanceof Date,
    'Order.create devuelve ambos timestamps',
  );
  assert.equal(
    order.shortId,
    String(order._id).slice(-6),
    'Order.create persiste el código corto denormalizado',
  );
  assert.ok(
    brand.createdAt instanceof Date && brand.updatedAt instanceof Date,
    'Brand.create devuelve ambos timestamps',
  );
});

test('save() de un pedido existente avanza updatedAt y conserva createdAt (PUT /api/orders/[id])', async () => {
  writes.length = 0;

  const order = await Order.create({ clientId: oid(), createdBy: 'vendedor' });
  const createdAt = order.createdAt;
  const previousUpdatedAt = order.updatedAt;

  await new Promise((resolve) => setTimeout(resolve, 10));
  order.status = 'paralizado';
  order.comments.push({
    text: 'Verificado en depósito',
    author: 'depósito',
    role: 'deposito',
  } as any);
  await order.save();

  const save = writes.find((write) => write.model === 'Order' && write.method === 'updateOne');
  assert.ok(save, 'el save de un documento existente debe actualizar por updateOne');
  assertFreshUpdatedAt(save.args[1], 'Order.save()', previousUpdatedAt.getTime());

  assert.equal(order.createdAt.getTime(), createdAt.getTime(), 'createdAt no cambia en el update');
  assert.ok(
    order.updatedAt.getTime() > previousUpdatedAt.getTime(),
    'updatedAt avanza con el save',
  );
});

test('bulkWrite del import de catálogo actualiza updatedAt y programa createdAt en los upserts', async () => {
  writes.length = 0;
  const start = Date.now();
  const brandId = oid();

  await Product.bulkWrite(
    [
      {
        updateOne: {
          // Igual que POST /api/catalog/import: el upsert setea price y priceWithIva,
          // que son obligatorios para evaluar los defaults del schema.
          filter: { brandId, code: 'P1' },
          update: {
            $set: {
              brandId,
              code: 'P1',
              name: 'Producto importado',
              price: 10,
              priceWithIva: 12.1,
              imageUrl: '',
            },
          },
          upsert: true,
        },
      },
    ],
    { ordered: false },
  );
  await Client.bulkWrite(
    [
      {
        updateOne: {
          filter: { code: 'C1' },
          update: {
            $set: {
              code: 'C1',
              name: 'Cliente importado',
              address: '',
              localidad: '',
              province: '',
              generalDiscount: 0,
            },
          },
          upsert: true,
        },
      },
    ],
    { ordered: false },
  );

  for (const model of [Product, Client]) {
    const bulk = writes.find(
      (write) => write.model === model.modelName && write.method === 'bulkWrite',
    );
    assert.ok(bulk, `${model.modelName}: el import debe ejecutar bulkWrite`);

    const operation = bulk.args[0][0].updateOne;
    assertFreshUpdatedAt(operation.update, `${model.modelName}.bulkWrite`, start);
    assert.ok(
      operation.update.$setOnInsert?.createdAt instanceof Date,
      `${model.modelName}: el upsert del import debe programar createdAt`,
    );
  }
});
