/** Hash de contraseñas compartido por login, alta de usuarios y cambio propio. */
import bcrypt from 'bcryptjs';

/** Costo acordado: bcrypt con 10 rondas. */
export const BCRYPT_ROUNDS = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}
