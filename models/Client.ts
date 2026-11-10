import mongoose, { Schema, Document, Model } from 'mongoose';
import { buildClientSearchFields } from '../lib/search-normalize';
import { registerSearchFieldHooks } from '../lib/search-schema';

export interface IBrandDiscount {
  brandId: mongoose.Types.ObjectId;
  discountPercentage: number;
}

export interface IClient extends Document {
  code: string;
  name: string;
  address: string;
  localidad: string;
  province: string;
  generalDiscount: number;
  brandDiscounts: IBrandDiscount[];
  /** Claves normalizadas (minúsculas, sin acentos) para búsqueda por prefijo. */
  searchName: string;
  searchCode: string;
  searchLocalidad: string;
  searchProvince: string;
  searchAddress: string;
  /** Palabras únicas normalizadas de code, name, dirección y localidad. */
  searchTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

const BrandDiscountSchema = new Schema<IBrandDiscount>({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  discountPercentage: { type: Number, required: true, default: 0 },
});

const ClientSchema = new Schema<IClient>(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: '' },
    localidad: { type: String, trim: true, default: '' },
    province: { type: String, trim: true, default: '' },
    generalDiscount: { type: Number, default: 0 },
    brandDiscounts: [BrandDiscountSchema],
    // Mantenidas por los hooks del schema/migración; no se exponen en los DTO.
    searchName: { type: String, default: '' },
    searchCode: { type: String, default: '' },
    searchLocalidad: { type: String, default: '' },
    searchProvince: { type: String, default: '' },
    searchAddress: { type: String, default: '' },
    searchTokens: { type: [String], default: [] },
  },
  { timestamps: true },
);

registerSearchFieldHooks(
  ClientSchema,
  {
    code: ['searchCode'],
    name: ['searchName'],
    address: ['searchAddress'],
    localidad: ['searchLocalidad'],
    province: ['searchProvince'],
  },
  buildClientSearchFields,
);

// El listado se ordena por name: el índice evita el SORT en memoria y el
// desempate por _id mantiene estables las páginas.
ClientSchema.index({ name: 1, _id: 1 });
// Búsqueda por prefijo: `/^termino/` sobre cada clave normalizada puede usar
// estos índices B-tree. Antes el regex `i` no anclado obligaba a recorrer toda
// la colección (y el countDocuments terminaba en COLLSCAN).
ClientSchema.index({ searchName: 1 });
ClientSchema.index({ searchCode: 1 });
ClientSchema.index({ searchLocalidad: 1 });
ClientSchema.index({ searchProvince: 1 });
ClientSchema.index({ searchAddress: 1 });
// Multikey de palabras: permite exigir todos los tokens en cualquier posición.
ClientSchema.index({ searchTokens: 1 });
// Snapshot incremental del catálogo offline: orden estable por actualización.
ClientSchema.index({ updatedAt: 1, _id: 1 });

export const Client: Model<IClient> =
  mongoose.models.Client || mongoose.model<IClient>('Client', ClientSchema);
