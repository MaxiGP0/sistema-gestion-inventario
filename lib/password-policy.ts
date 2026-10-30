/**
 * Política de contraseñas compartida por el servidor (Zod) y el formulario de
 * cambio de contraseña del cliente.
 *
 * Es un módulo puro para que el formulario no arrastre dependencias de Node ni
 * de bcrypt al bundle del navegador.
 */

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_MIN_LENGTH_MESSAGE = `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`;
export const PASSWORD_MAX_LENGTH_MESSAGE = `La contraseña no puede superar los ${PASSWORD_MAX_LENGTH} caracteres`;
