import mongoose, { Schema, Document, Model } from 'mongoose';
import { buildBrandSearchFields } from '../lib/search-normalize';
import { registerSearchFieldHooks } from '../lib/search-schema';

export interface IBrand extends Document {
  name: string;
  codePrefix?: string;
  /** Clave normalizada (minúsculas, sin acentos) para búsqueda por prefijo. */
  searchName: string;
  createdAt: Date;
  updatedAt: Date;
}

const BrandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    codePrefix: { type: String, trim: true },
    searchName: { type: String, default: '' },
  },
  { timestamps: true },
);

registerSearchFieldHooks(BrandSchema, { name: ['searchName'] }, buildBrandSearchFields);

// GET /api/products resuelve las marcas por prefijo normalizado en lugar de un
// regex `i` no anclado sobre name.
BrandSchema.index({ searchName: 1 });

export const Brand: Model<IBrand> =
  mongoose.models.Brand || mongoose.model<IBrand>('Brand', BrandSchema);
