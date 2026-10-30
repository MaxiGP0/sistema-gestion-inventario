import type { UserRole } from '../authz';
import type { ApiMessageResponse } from './common';

/**
 * Usuario administrable expuesto por `/api/users` y el backoffice.
 * Nunca incluye `passwordHash` ni `sessionVersion`.
 */
export interface UserDTO {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  notificationsEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
}

/** `GET /api/users` */
export interface UserListResponse {
  success: true;
  users: UserDTO[];
}

/** `POST/PATCH /api/users` */
export interface UserMutationResponse extends ApiMessageResponse {
  user: UserDTO;
}

/** `POST /api/auth/change-password` */
export type ChangePasswordResponse = ApiMessageResponse;
