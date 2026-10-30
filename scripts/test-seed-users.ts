/**
 * Pruebas de `parseSeedUsers` (lib/seed-users.ts): formato Nombre[rol]:contraseña,
 * separadores coma/salto de línea, tolerancia de espacios, validaciones y
 * detección de duplicados.
 *
 * Los mensajes de error no deben incluir contraseñas, porque el seed los
 * imprime en los logs.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSeedUsers } from '../lib/seed-users';

test('parsea entradas separadas por coma o salto de línea y tolera espacios', () => {
  const raw = [
    '  Hernan [ vendedor ] : 4535 ,',
    'Jose[vendedor]:7351',
    '  Mateo[controlador]:7556  ',
    '',
  ].join('\r\n');

  const result = parseSeedUsers(raw);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.users, [
    { username: 'Hernan', role: 'vendedor', password: '4535' },
    { username: 'Jose', role: 'vendedor', password: '7351' },
    { username: 'Mateo', role: 'controlador', password: '7556' },
  ]);
});

test('acepta coma y salto de línea mezclados e ignora entradas vacías', () => {
  const result = parseSeedUsers('Ana[vendedor]:uno,\n\nLuis[controlador]:dos,\n');

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.users.map((user) => user.username),
    ['Ana', 'Luis'],
  );
});

test('devuelve listas vacías si SEED_USERS no está definida o está vacía', () => {
  for (const raw of [undefined, null, '', '   ', '\n,\r\n']) {
    assert.deepEqual(parseSeedUsers(raw), { users: [], errors: [] });
  }
});

test('normaliza el rol a minúsculas y conserva los dos puntos internos de la contraseña', () => {
  const result = parseSeedUsers('Ana[ VENDEDOR ]:clave:con:dos:puntos');

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.users, [
    { username: 'Ana', role: 'vendedor', password: 'clave:con:dos:puntos' },
  ]);
});

test('rechaza un rol fuera de vendedor | controlador', () => {
  const result = parseSeedUsers('Ana[admin]:clave-secreta');

  assert.equal(result.users.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /rol inválido "admin"/);
  assert.match(result.errors[0], /vendedor o controlador/);
  assert.ok(!result.errors[0].includes('clave-secreta'));
});

test('rechaza entradas sin ":" o sin el formato Nombre[rol]', () => {
  const missingColon = parseSeedUsers('Ana[vendedor]');
  assert.equal(missingColon.users.length, 0);
  assert.match(missingColon.errors[0], /falta ":"/);

  const missingRole = parseSeedUsers('Ana:vendedor');
  assert.equal(missingRole.users.length, 0);
  assert.match(missingRole.errors[0], /formato inválido/);

  const missingBrackets = parseSeedUsers('Ana[vendedor:clave');
  assert.equal(missingBrackets.users.length, 0);
  assert.match(missingBrackets.errors[0], /formato inválido/);
});

test('rechaza nombre vacío, nombre con corchetes y contraseña vacía', () => {
  const emptyName = parseSeedUsers('[vendedor]:clave');
  assert.equal(emptyName.users.length, 0);
  assert.match(emptyName.errors[0], /el nombre no puede estar vacío/);

  const bracketedName = parseSeedUsers('Ana[Maria][vendedor]:clave');
  assert.equal(bracketedName.users.length, 0);
  assert.match(bracketedName.errors[0], /no puede contener corchetes/);

  const emptyPassword = parseSeedUsers('Ana[vendedor]:   ');
  assert.equal(emptyPassword.users.length, 0);
  assert.match(emptyPassword.errors[0], /contraseña de "Ana" no puede estar vacía/);
});

test('detecta duplicados sin distinguir mayúsculas y reporta ambas entradas', () => {
  const result = parseSeedUsers('Ana[vendedor]:clave-uno\nana[controlador]:clave-dos');

  assert.equal(result.users.length, 1);
  assert.equal(result.users[0].username, 'Ana');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /usuario "ana" está duplicado/);
  assert.match(result.errors[0], /entrada 1/);
  assert.ok(!result.errors[0].includes('clave-uno'));
  assert.ok(!result.errors[0].includes('clave-dos'));
});

test('acumula errores de varias entradas y devuelve las válidas sin filtrar contraseñas', () => {
  const result = parseSeedUsers(
    [
      'Ana[admin]:secreto-ana',
      'Beto[vendedor]:secreto-beto',
      'Beto[vendedor]:secreto-duplicado',
      'Carla[controlador]:secreto-carla',
      'Dario[vendedor]:',
    ].join('\n'),
  );

  // Ana (rol inválido), Beto repetido y Dario (sin contraseña) fallan.
  assert.deepEqual(
    result.users.map((user) => user.username),
    ['Beto', 'Carla'],
  );
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /Entrada 1/);
  assert.match(result.errors[1], /Entrada 3/);
  assert.match(result.errors[2], /Entrada 5/);

  for (const error of result.errors) {
    for (const password of ['secreto-ana', 'secreto-beto', 'secreto-duplicado', 'secreto-carla']) {
      assert.ok(!error.includes(password), `el error no debe incluir "${password}": ${error}`);
    }
  }
});
