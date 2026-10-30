import type { ApiMessageResponse } from './common';

/** Descuento por marca configurado en la ficha del cliente. */
export interface ClientBrandDiscountDTO {
  brandId: string;
  discountPercentage: number;
}

/** Cliente serializable que consumen backoffice, alta de pedidos y pedidos. */
export interface ClientDTO {
  _id: string;
  code: string;
  name: string;
  address: string;
  localidad: string;
  province: string;
  generalDiscount: number;
  brandDiscounts: ClientBrandDiscountDTO[];
}

export interface ClientListResult {
  clients: ClientDTO[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** `GET /api/clients` */
export interface ClientListResponse extends ClientListResult {
  success: true;
}

/** `GET /api/clients/[id]` */
export interface ClientDetailResponse {
  success: true;
  client: ClientDTO;
}

/** `POST /api/clients` y `PUT /api/clients/[id]` */
export interface ClientMutationResponse extends ApiMessageResponse {
  client: ClientDTO;
}
