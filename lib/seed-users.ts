/**
 * Parseo de la variable `SEED_USERS`, que define usuarios adicionales para el
 * seed con el formato `Nombre[rol]:contraseña`.
 *
 * - Las entradas se separan con coma o salto de línea.
 * - Se toleran espacios alrededor de la entrada, el nombre, el rol y la
 *   contraseña (la contraseña conserva los espacios internos).
 * - Roles válidos: `vendedor` y `controlador`.
 * - Se detectan duplicados por nombre sin distinguir mayúsculas/minúsculas.
 *
 * Los errores nunca incluyen la contraseña: sólo la entrada y el nombre, para
 * que se puedan mostrar en logs sin filtrar credenciales.
 */

export const SEED_USER_ROLES = ['vendedor', 'controlador'] as const;

export type SeedUserRole = (typeof SEED_USER_ROLES)[number];

export interface SeedUser {
  username: string;
  role: SeedUserRole;
  password: string;
}

export interface ParseSeedUsersResult {
  /** Entradas válidas, en el orden en que aparecen. */
  users: SeedUser[];
  /** Errores legibles; si hay al menos uno, el seed debe abortar sin escribir. */
  errors: string[];
}

/** Separa por coma o salto de línea (Windows o Unix). */
const ENTRY_SEPARATOR = /[,\r\n]+/;

/** `Nombre[rol]`; el nombre puede tener espacios internos. */
const USER_ENTRY = /^(.*?)\s*\[([^\]]*)\]\s*$/;

const isValidRole = (role: string): role is SeedUserRole =>
  (SEED_USER_ROLES as readonly string[]).includes(role);

export function parseSeedUsers(raw: string | null | undefined): ParseSeedUsersResult {
  const users: SeedUser[] = [];
  const errors: string[] = [];

  if (!raw || !raw.trim()) {
    return { users, errors };
  }

  // Las entradas vacías (comas o líneas de más) se ignoran en silencio.
  const entries = raw.split(ENTRY_SEPARATOR).filter((entry) => entry.trim() !== '');

  // Clave normalizada -> número de entrada donde apareció por primera vez.
  const seenUsernames = new Map<string, number>();

  entries.forEach((entry, index) => {
    const entryNumber = index + 1;
    const colonIndex = entry.indexOf(':');

    if (colonIndex === -1) {
      errors.push(`Entrada ${entryNumber}: falta ":" entre Nombre[rol] y la contraseña.`);
      return;
    }

    const head = entry.slice(0, colonIndex).trim();
    const password = entry.slice(colonIndex + 1).trim();
    const match = head.match(USER_ENTRY);

    if (!match) {
      errors.push(`Entrada ${entryNumber}: formato inválido, se esperaba Nombre[rol]:contraseña.`);
      return;
    }

    const username = match[1].trim();
    const roleValue = match[2].trim();
    const role = roleValue.toLowerCase();
    let isValid = true;

    if (!username) {
      errors.push(`Entrada ${entryNumber}: el nombre no puede estar vacío.`);
      isValid = false;
    } else if (/[[\]]/.test(username)) {
      errors.push(`Entrada ${entryNumber}: el nombre "${username}" no puede contener corchetes.`);
      isValid = false;
    }

    if (!isValidRole(role)) {
      errors.push(
        `Entrada ${entryNumber}: rol inválido "${roleValue}" para "${username || 'sin nombre'}"; ` +
          'debe ser vendedor o controlador.',
      );
      isValid = false;
    }

    if (!password) {
      errors.push(
        `Entrada ${entryNumber}: la contraseña de "${username || 'sin nombre'}" no puede estar vacía.`,
      );
      isValid = false;
    }

    if (!isValid || !isValidRole(role)) {
      return;
    }

    const normalizedUsername = username.toLowerCase();
    const previousEntry = seenUsernames.get(normalizedUsername);

    if (previousEntry !== undefined) {
      errors.push(
        `Entrada ${entryNumber}: el usuario "${username}" está duplicado ` +
          `(ya apareció en la entrada ${previousEntry}).`,
      );
      return;
    }

    seenUsernames.set(normalizedUsername, entryNumber);
    users.push({ username, role, password });
  });

  return { users, errors };
}
