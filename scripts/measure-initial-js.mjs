/**
 * Mide el JavaScript inicial por ruta a partir del build de producción.
 *
 * Lee los HTML prerenderizados de `.next/server/app`, suma los chunks
 * `/_next/static/chunks/*.js` referenciados y los tamaños de fuente precargados.
 * Imprime bytes sin comprimir y comprimidos con gzip (como los sirve Next).
 *
 * Uso: `npm run build && node scripts/measure-initial-js.mjs`.
 * Con `--json` emite el detalle por ruta para comparar dos builds.
 * Con `--check` compara contra `performance-budgets.json` y falla si una ruta
 * supera el presupuesto o si falta una ruta presupuestada.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const appDir = join(root, '.next', 'server', 'app');
const budgetsFile = join(root, 'performance-budgets.json');

if (!existsSync(appDir)) {
  console.error('No hay build en .next/server/app. Ejecutá `npm run build` primero.');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function sizeOf(urlPath) {
  const file = join(root, urlPath.replace(/^\/_next\//, '.next/'));
  if (!existsSync(file)) return { size: 0, gzip: 0 };
  const raw = readFileSync(file);
  return { size: raw.length, gzip: gzipSync(raw).length };
}

const rows = [];

for (const file of walk(appDir).filter((name) => name.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  const scripts = new Set(
    [...html.matchAll(/(?:src|href)="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]),
  );
  const fonts = new Set(
    [...html.matchAll(/href="(\/_next\/static\/media\/[^"]+\.(?:woff2?|ttf))"/g)].map((m) => m[1]),
  );

  const js = [...scripts].reduce(
    (total, src) => {
      const { size, gzip } = sizeOf(src);
      return { size: total.size + size, gzip: total.gzip + gzip };
    },
    { size: 0, gzip: 0 },
  );
  const fontBytes = [...fonts].reduce((total, src) => total + sizeOf(src).size, 0);

  rows.push({
    route:
      '/' +
      relative(appDir, file)
        .replace(/\\/g, '/')
        .replace(/\.html$/, '')
        .replace(/^index$/, '')
        .replace(/\/(index|page)$/, ''),
    jsBytes: js.size,
    jsGzipBytes: js.gzip,
    fontBytes,
    chunks: scripts.size,
  });
}

rows.sort((a, b) => b.jsGzipBytes - a.jsGzipBytes);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function checkBudgets() {
  if (!existsSync(budgetsFile)) {
    console.error(`No existe ${budgetsFile}.`);
    process.exit(1);
  }

  const budgets = JSON.parse(readFileSync(budgetsFile, 'utf8'));
  const routeBudgets = budgets.bundle?.routes ?? {};
  const defaultBudget = budgets.bundle?.default;
  const rowsByRoute = new Map(rows.map((row) => [row.route, row]));
  const violations = [];
  const missing = Object.keys(routeBudgets).filter((route) => !rowsByRoute.has(route));

  for (const route of missing) {
    violations.push(`Falta la ruta presupuestada ${route} en el build.`);
  }

  console.log('Ruta'.padEnd(32), 'JS gzip'.padStart(12), 'Presup.'.padStart(12), 'Estado');
  for (const row of rows) {
    const budget = routeBudgets[row.route] ?? defaultBudget;
    if (!budget) continue;

    const outOfBudget = row.jsGzipBytes > budget.jsGzipBytes;

    if (outOfBudget) {
      violations.push(
        `${row.route}: ${kb(row.jsGzipBytes)} gzip supera el presupuesto de ${kb(budget.jsGzipBytes)}.`,
      );
    }

    if (typeof budget.jsBytes === 'number' && row.jsBytes > budget.jsBytes) {
      violations.push(
        `${row.route}: ${kb(row.jsBytes)} sin comprimir supera el presupuesto de ${kb(budget.jsBytes)}.`,
      );
    }

    console.log(
      row.route.padEnd(32),
      kb(row.jsGzipBytes).padStart(12),
      kb(budget.jsGzipBytes).padStart(12),
      outOfBudget ? 'FALLA' : 'OK',
    );
  }

  if (violations.length > 0) {
    console.error('\nPresupuesto de bundle incumplido:');
    for (const violation of violations) console.error(` - ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nOK: ${rows.length} rutas dentro del presupuesto de JS inicial.`);
}

if (process.argv.includes('--check')) {
  checkBudgets();
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('Ruta'.padEnd(32), 'JS gzip'.padStart(10), 'JS'.padStart(10), 'Fuentes'.padStart(10));
  for (const row of rows) {
    console.log(
      row.route.padEnd(32),
      kb(row.jsGzipBytes).padStart(10),
      kb(row.jsBytes).padStart(10),
      kb(row.fontBytes).padStart(10),
    );
  }

  const fonts = new Set(
    walk(appDir)
      .filter((name) => name.endsWith('.html'))
      .flatMap((file) =>
        [
          ...readFileSync(file, 'utf8').matchAll(/href="(\/_next\/static\/media\/[^"]+\.woff2?)"/g),
        ].map((m) => m[1]),
      ),
  );
  console.log('\nFuentes distintas:', fonts.size);
  for (const font of fonts)
    console.log(' ', font, kb(statSync(join(root, font.replace(/^\/_next\//, '.next/'))).size));
}
