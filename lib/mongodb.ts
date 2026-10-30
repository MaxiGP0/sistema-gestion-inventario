import mongoose from 'mongoose';
import { getEnv } from './env';

interface CachedMongoose {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var mongoose: CachedMongoose | undefined;
}

const cached: CachedMongoose = global.mongoose || { conn: null, promise: null };
if (!global.mongoose) {
  global.mongoose = cached;
}

/**
 * La caché vive en `globalThis` y se consulta en cada llamada (no se captura
 * una referencia al cargar el módulo): los tests pueden inyectar una conexión
 * falsa después de importar un route handler sin abrir una conexión real.
 */
function getCachedMongoose(): CachedMongoose {
  if (!global.mongoose) {
    global.mongoose = { conn: null, promise: null };
  }

  return global.mongoose;
}

async function dbConnect() {
  const cached = getCachedMongoose();
  // La conexión cacheada se devuelve antes de validar el entorno: en tests se
  // inyecta una conexión falsa y no hace falta una URI real.
  if (cached.conn) {
    return cached.conn;
  }

  const { MONGODB_URI } = getEnv();

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      // Un health check no debe quedarse esperando 30 s si Mongo no responde.
      serverSelectionTimeoutMS: 5000,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

export default dbConnect;
