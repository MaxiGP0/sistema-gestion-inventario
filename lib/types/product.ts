import type { ApiMessageResponse } from './common';

/** Marca embebida en el populate de un producto. */
export interface ProductBrandDTO {
  _id: string;
  name: string;
  codePrefix?: string;
}

/** Producto serializable del catálogo. */
export interface ProductDTO {
  _id: string;
  brandId: ProductBrandDTO;
  code: string;
  name: string;
  price: number;
  priceWithIva: number;
  imageUrl?: string;
}

export interface ProductListResult {
  products: ProductDTO[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** `GET /api/products` */
export interface ProductListResponse extends ProductListResult {
  success: true;
  hasMore: boolean;
}

/** `POST /api/products` y `PUT /api/products/[id]` */
export interface ProductMutationResponse extends ApiMessageResponse {
  product: ProductDTO;
}

/** `POST /api/products/bulk-price` */
export interface BulkPriceAdjustmentResponse extends ApiMessageResponse {
  /** Productos activos alcanzados por la marca (o todo el catálogo). */
  matched: number;
  /** Productos cuyo precio cambió. */
  updated: number;
  /** Marca ajustada; `null` cuando se aplicó a todas. */
  brandId: string | null;
  percentage: number;
}
