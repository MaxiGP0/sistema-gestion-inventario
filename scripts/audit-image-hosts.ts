/**
 * Auditoría de hosts de imágenes del catálogo.
 *
 * Lee los `Product.imageUrl` distintos de la base configurada, extrae el
 * hostname y lista los que no pasan por la allowlist de `lib/image-sources.ts`.
 * Sirve para detectar proveedores nuevos antes de que sus miniaturas caigan al
 * placeholder por no estar en `next.config.ts`.
 *
 * Uso:
 *   npm run audit:image-hosts
 *   MONGODB_URI="mongodb+srv://…/sgi" npm run audit:image-hosts
 *   npm run audit:image-hosts -- --json
 *
 * El script lee `.env.local` (MONGODB_URI) igual que los seeds. No imprime URLs
 * completas: sólo protocolo + hostname, para no filtrar tokens de firma.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });

import mongoose from 'mongoose';
import { Product } from '../models/Product';
import { isOptimizableImageHostname } from '../lib/image-sources';

interface HostReport {
  host: string;
  optimizable: boolean;
  urls: number;
}

function hostnameOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) return '(ruta local)';

  try {
    const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
    return url.hostname.toLowerCase() || '(sin host)';
  } catch {
    return '(valor inválido)';
  }
}

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('Falta MONGODB_URI. Definila en .env.local o en el entorno.');
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });

  try {
    const distinct = (await Product.distinct('imageUrl')) as unknown[];
    const values = distinct
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value !== '');

    const byHost = new Map<string, { urls: Set<string>; optimizable: boolean }>();

    for (const value of values) {
      const host = hostnameOf(value);
      const entry = byHost.get(host) ?? {
        urls: new Set<string>(),
        // Las rutas locales no tienen host que validar; los valores inválidos
        // se marcan para que aparezcan explícitamente en la auditoría.
        optimizable:
          host === '(ruta local)' ||
          (host !== '(valor inválido)' && isOptimizableImageHostname(host)),
      };
      entry.urls.add(value);
      byHost.set(host, entry);
    }

    const reports: HostReport[] = [...byHost.entries()]
      .map(([host, entry]) => ({
        host,
        optimizable: entry.optimizable,
        urls: entry.urls.size,
      }))
      .sort((a, b) => Number(a.optimizable) - Number(b.optimizable) || b.urls - a.urls);

    const unoptimized = reports.filter((report) => !report.optimizable);

    if (process.argv.includes('--json')) {
      console.log(
        JSON.stringify(
          {
            totalUrls: values.length,
            totalHosts: reports.length,
            unoptimizedHosts: unoptimized,
          },
          null,
          2,
        ),
      );
      if (unoptimized.length > 0) process.exitCode = 1;
      return;
    }

    console.log(`URLs de imagen distintas: ${values.length}`);
    console.log(`Hosts distintos: ${reports.length}`);

    if (reports.length === 0) {
      console.log('No hay imageUrl cargadas en la base.');
      return;
    }

    console.log('\nHost                    URLs  Estado');
    for (const report of reports) {
      console.log(
        report.host.padEnd(22),
        String(report.urls).padStart(5),
        report.optimizable ? 'optimizable' : 'NO ESTÁ EN LA ALLOWLIST',
      );
    }

    if (unoptimized.length > 0) {
      console.log(
        `\nAgregá estos hosts a OPTIMIZABLE_IMAGE_HOSTS en lib/image-sources.ts: ${unoptimized
          .map((report) => report.host)
          .join(', ')}`,
      );
      process.exitCode = 1;
    } else {
      console.log('\nOK: todos los hosts de imágenes pasan por /_next/image.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('[audit:image-hosts] Error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
