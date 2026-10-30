import mongoose, { Schema, Document, Model } from 'mongoose';
import { buildProductSearchFields } from '../lib/search-normalize';
import { registerSearchFieldHooks } from '../lib/search-schema';
import './Brand';

export interface IProduct extends Document {
  brandId: mongoose.Types.ObjectId;
  code: string;
  name: string;
  imageUrl?: string;
  price: number;
  priceWithIva: number;
  /** Baja lógica: false = fuera del catálogo pero visible en pedidos históricos. */
  active: boolean;
  /** Claves normalizadas (minúsculas, sin acentos) para búsqueda por prefijo. */
  searchName: string;
  searchCode: string;
  /** Palabras únicas normalizadas de code y name (índice multikey). */
  searchTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema = new Schema<IProduct>(
  {
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    imageUrl: { type: String, trim: true },
    active: { type: Boolean, default: true },
    price: { type: Number, required: true, default: 0 },
    priceWithIva: {
      type: Number,
      required: true,
      // En upserts masivos (bulkWrite) setDefaultsOnInsert evalúa el default con
      // this = null: this?.price evita el TypeError que rompía el import.
      default: function (this: any) {
        const price = this?.price;
        return price ? Number((price * 1.21).toFixed(2)) : 0;
      },
    },
    searchName: { type: String, default: '' },
    searchCode: { type: String, default: '' },
    searchTokens: { type: [String], default: [] },
  },
  { timestamps: true },
);

registerSearchFieldHooks(
  ProductSchema,
  { code: ['searchCode'], name: ['searchName'] },
  buildProductSearchFields,
);

// Compound unique index for brandId and product code.
// Cubre también las consultas por brandId solo (prefijo del índice compuesto),
// por eso no se necesita un índice adicional sobre brandId.
ProductSchema.index({ brandId: 1, code: 1 }, { unique: true });
// Catálogo filtrado por marca: brandId acota el scan, name resuelve el orden
// del listado sin SORT en memoria y active queda cubierto en el índice. Este
// orden importa: con active antes de name, `active: { $ne: false }` obliga a un
// SORT_MERGE entre dos rangos y el planner prefiere escanear todo el catálogo.
ProductSchema.index({ brandId: 1, name: 1, active: 1 });
// Catálogo sin filtro de marca (backoffice): orden por name y descarte de las
// bajas lógicas directamente sobre el índice.
ProductSchema.index({ name: 1, active: 1 });
// Prefijo normalizado para el buscador. `active` se mantiene en el índice para
// resolver el filtro fijo del catálogo sin COLLSCAN.
ProductSchema.index({ searchName: 1, active: 1 });
ProductSchema.index({ searchCode: 1, active: 1 });
// Multikey: cada palabra de code/name es una entrada del índice. Las consultas
// multi-token (`$all` de prefijos anclados) se resuelven sin recorrer el catálogo.
ProductSchema.index({ searchTokens: 1, active: 1 });

export const Product: Model<IProduct> =
  mongoose.models.Product || mongoose.model<IProduct>('Product', ProductSchema);
