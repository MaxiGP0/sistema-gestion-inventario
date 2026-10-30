import type { UserRole } from '../authz';
import type { ApiMessageResponse } from './common';

/** Usuario de la sesión tal como lo expone la API (nunca incluye el hash). */
export interface AuthUserDTO {
  id: string;
  username: string;
  role: UserRole;
  notificationsEnabled: boolean;
}

/** `GET /api/auth/session` */
export interface SessionResponse {
  success: true;
  user: AuthUserDTO;
}

/** `POST /api/auth/login` */
export interface LoginResponse extends ApiMessageResponse {
  user: AuthUserDTO;
}

/** `POST /api/auth/logout` */
export type LogoutResponse = ApiMessageResponse;
