import type { ApiMessageResponse } from './common';

/** Marca serializable que consumen backoffice y alta de pedidos. */
export interface BrandDTO {
  _id: string;
  name: string;
  codePrefix?: string;
}

/** `GET /api/brands` */
export interface BrandListResponse {
  success: true;
  brands: BrandDTO[];
}

/** `POST /api/brands` y `PUT /api/brands/[id]` */
export interface BrandMutationResponse extends ApiMessageResponse {
  brand: BrandDTO;
}
