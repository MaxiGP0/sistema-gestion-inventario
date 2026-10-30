import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import dbConnect from '../lib/mongodb';

/**
 * Migración única: elimina el compuesto legacy
 * `name_text_code_1_localidad_1_province_1` de la colección `clients`.
 *
 * Ese índice ({ name: 'text', code: 1, localidad: 1, province: 1 }) sólo lo
 * habría usado una consulta $text, que la app nunca hace: la búsqueda de
 * clientes es por regex case-insensitive sobre code, name, localidad, province
 * y address, y un regex no anclado no puede usar índices B-tree. El schema ya
 * no lo declara; esta migración lo saca de las bases existentes. Una
 * alternativa equivalente es ejecutar Client.syncIndexes() una vez.
 *
 * Ejecutar una sola vez:
 *   npx tsx scripts/migrate-drop-client-search-index.ts
 */

const COLLECTION_NAME = 'clients';
const LEGACY_INDEX_NAME = 'name_text_code_1_localidad_1_province_1';
const NAMESPACE_NOT_FOUND = 26;

async function migrate() {
  try {
    console.log('Conectando a MongoDB...');
    const mongoose = await dbConnect();
    console.log('¡Conectado exitosamente!');

    const collection = mongoose.connection.collection(COLLECTION_NAME);

    let indexNames: string[];
    try {
      indexNames = (await collection.indexes())
        .map((index) => index.name)
        .filter((name): name is string => Boolean(name));
    } catch (error) {
      if ((error as { code?: number }).code === NAMESPACE_NOT_FOUND) {
        console.log(`La colección "${COLLECTION_NAME}" no existe: nada que migrar.`);
        process.exit(0);
      }
      throw error;
    }

    if (!indexNames.includes(LEGACY_INDEX_NAME)) {
      console.log(
        `El índice "${LEGACY_INDEX_NAME}" no existe en "${COLLECTION_NAME}": nada que migrar.`,
      );
      process.exit(0);
    }

    await collection.dropIndex(LEGACY_INDEX_NAME);
    console.log(`Índice "${LEGACY_INDEX_NAME}" eliminado de la colección "${COLLECTION_NAME}".`);
    console.log('¡Migración completada exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('Error durante la migración:', error);
    process.exit(1);
  }
}

migrate();
