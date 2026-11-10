import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import puppeteer from 'puppeteer-core';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Lighthouse CI móvil para las rutas principales.
 *
 * - Levanta Next en modo producción (`next start`) y una base efímera sembrada
 *   si no hay `MONGODB_URI` (en CI se usa el servicio de Mongo del workflow).
 * - Usa Chromium de Playwright, sesión autenticada con el admin E2E y el preset
 *   mobile de Lighthouse (CPU 4x, throttling de red móvil).
 * - Compara LCP, CLS y TBT contra `performance-budgets.json` y publica los
 *   reportes HTML/JSON en `.lighthouseci/`.
 *
 * Uso local:
 *   npm run build
 *   npm run perf:lighthouse
 *
 * Requisitos: `npm run build` y, si se usa un Mongo externo, haber corrido
 * `npm run seed:e2e`. Con `LIGHTHOUSE_MEMORY_MONGO=1` el script levanta y
 * siembra su propia base, igual que los E2E.
 */

const require = createRequire(import.meta.url);
const root = process.cwd();
const budgetsFile = join(root, 'performance-budgets.json');
const reportsDir = join(root, '.lighthouseci');
const baseUrl = process.env.LIGHTHOUSE_BASE_URL ?? 'http://127.0.0.1:3200';
const port = new URL(baseUrl).port || '3200';

const LOGIN_USER = process.env.LIGHTHOUSE_USER ?? 'e2e-admin';
const LOGIN_PASSWORD = process.env.LIGHTHOUSE_PASSWORD ?? 'InventarioE2E2026!';
const AUTH_SECRET = process.env.AUTH_SECRET ?? 'lighthouse-auth-secret-0123456789';

const budgets = JSON.parse(readFileSync(budgetsFile, 'utf8')).lighthouse;
const RUNS = Math.max(1, budgets.runs ?? 2);

/** Valores del preset mobileSlow4G de Lighthouse 13 (CPU 4x). */
const MOBILE_THROTTLING = {
  rttMs: 150,
  throughputKbps: 1638.4,
  cpuSlowdownMultiplier: 4,
  requestLatencyMs: 562.5,
  downloadThroughputKbps: 1474.56,
  uploadThroughputKbps: 675,
};

const LIGHTHOUSE_CONFIG = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: 'mobile',
    screenEmulation: {
      mobile: true,
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      disabled: false,
    },
    throttlingMethod: 'simulate',
    throttling: MOBILE_THROTTLING,
    onlyCategories: ['performance'],
  },
};

const ROUTES = [
  { path: '/login', key: '/login', authenticated: false },
  { path: '/', key: '/', authenticated: true },
  { path: '/orders/new', key: '/orders/new', authenticated: true },
  { path: '/deposit/orders', key: '/deposit/orders', authenticated: true },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.status < 500) return;
    } catch {
      // Todavía no escucha.
    }

    await sleep(500);
  }

  throw new Error(`El servidor no respondió en ${url} después de ${timeoutMs} ms.`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  child.kill('SIGTERM');
  await sleep(2_000);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function runSeed(uri) {
  return new Promise((resolve, reject) => {
    const tsxCli = require.resolve('tsx/cli');
    const child = spawn(process.execPath, [tsxCli, 'scripts/seed-e2e-cli.ts'], {
      cwd: root,
      env: { ...process.env, E2E_MONGODB_URI: uri },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`El seed E2E terminó con código ${code}.`));
    });
  });
}

async function startNext(uri) {
  const nextCli = require.resolve('next/dist/bin/next');
  const child = spawn(
    process.execPath,
    [nextCli, 'start', '--port', port, '--hostname', '127.0.0.1'],
    {
      cwd: root,
      env: {
        ...process.env,
        MONGODB_URI: uri,
        AUTH_SECRET,
        LOG_LEVEL: 'error',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = [];

  const capture = (chunk) => {
    const text = chunk.toString();
    output.push(text);
    if (output.length > 80) output.shift();
  };

  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    await waitForServer(new URL('/login', baseUrl).href);
  } catch (error) {
    await stopProcess(child);
    throw new Error(`${error.message}\n${output.join('')}`);
  }

  return child;
}

async function authenticateWithApi(page, targetUrl) {
  await page.goto(new URL('/login', targetUrl).href, { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(
    async (credentials) => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      return response.status;
    },
    { username: LOGIN_USER, password: LOGIN_PASSWORD },
  );

  if (status !== 200) {
    throw new Error(`No se pudo iniciar sesión para Lighthouse (HTTP ${status}).`);
  }
}

async function prepareSession(browser, targetUrl) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true });
    const authenticated = new URL(targetUrl).pathname !== '/login';

    // Para rutas autenticadas se entra por el panel: si la cookie sigue
    // vigente no hay redirect a /login; si no, se autentica por API sin
    // depender de que React ya haya hidratado el formulario.
    await page.goto(new URL(authenticated ? '/' : '/login', targetUrl).href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    if (!authenticated) {
      const cdp = await page.createCDPSession();
      await cdp.send('Network.clearBrowserCookies');
      return;
    }

    if (await page.$('#login-username')) {
      await authenticateWithApi(page, targetUrl);
    }
  } finally {
    await page.close();
  }
}

async function discoverDetailPath(browser, targetUrl) {
  const page = await browser.newPage();

  try {
    await authenticateWithApi(page, targetUrl);

    const orderId = await page.evaluate(async () => {
      const response = await fetch(
        '/api/orders?status=borrador&archived=false&pagination=cursor&limit=1',
      );
      if (!response.ok) return null;

      const payload = await response.json();
      return payload.orders?.[0]?._id ?? null;
    });

    return orderId ? `/deposit/orders/${orderId}` : null;
  } finally {
    await page.close();
  }
}

function auditValue(lhr, auditId) {
  const value = lhr.audits[auditId]?.numericValue;
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function readLighthouseMetrics(lhr) {
  const imageRequests =
    lhr.audits['network-requests']?.details?.items?.filter(
      (item) => item.resourceType === 'Image',
    ) ?? [];
  const imageBytes = imageRequests.reduce(
    (total, item) => total + (Number(item.transferSize) || 0),
    0,
  );
  const bfCacheAudit = lhr.audits['bf-cache'];
  const bfCacheReasons =
    bfCacheAudit?.details?.items
      ?.map((item) => (typeof item.reason === 'string' ? item.reason : ''))
      .filter(Boolean) ?? [];

  return {
    lcpMs: auditValue(lhr, 'largest-contentful-paint'),
    cls: Math.round(auditValue(lhr, 'cumulative-layout-shift') * 10_000) / 10_000,
    tbtMs: auditValue(lhr, 'total-blocking-time'),
    ttfbMs: auditValue(lhr, 'server-response-time'),
    fcpMs: auditValue(lhr, 'first-contentful-paint'),
    imageBytes,
    imageCount: imageRequests.length,
    totalByteWeightBytes: auditValue(lhr, 'total-byte-weight'),
    performanceScore: Math.round((lhr.categories.performance?.score ?? 0) * 100),
    bfCacheScore: typeof bfCacheAudit?.score === 'number' ? Math.round(bfCacheAudit.score) : null,
    bfCacheReasons,
  };
}

function routeSlug(key) {
  if (key === '/') return 'panel';
  return key
    .replace(/^\//, '')
    .replace(/\[id\]/g, 'detail')
    .replace(/\//g, '-')
    .replace(/-+/g, '-');
}

async function runLighthouse(url, chromePort) {
  const result = await lighthouse(
    url,
    {
      port: chromePort,
      output: ['html', 'json'],
      logLevel: 'error',
      onlyCategories: ['performance'],
    },
    LIGHTHOUSE_CONFIG,
  );

  if (!result) throw new Error(`Lighthouse no devolvió resultados para ${url}.`);

  const reports = Array.isArray(result.report) ? result.report : [result.report];
  // El HTML de Lighthouse arranca con un comentario de licencia antes del
  // doctype, así que no alcanza con `startsWith`.
  const html = reports.find((report) => /<!doctype html>/i.test(report)) ?? '';
  const json = JSON.stringify(result.lhr, null, 2);

  return { lhr: result.lhr, html, json };
}

async function main() {
  if (!existsSync(join(root, '.next', 'BUILD_ID'))) {
    throw new Error('No hay build de producción. Ejecutá `npm run build` primero.');
  }

  mkdirSync(reportsDir, { recursive: true });

  let mongo = null;
  let server = null;
  let chrome = null;
  let browser = null;

  try {
    let mongodbUri = process.env.MONGODB_URI;

    if (!mongodbUri || process.env.LIGHTHOUSE_MEMORY_MONGO === '1') {
      mongo = await MongoMemoryServer.create({
        instance: { port: 27021, dbName: 'sgi-lighthouse-e2e' },
      });
      mongodbUri = mongo.getUri('sgi-lighthouse-e2e');
      console.log(`[lighthouse] MongoDB efímero en ${mongodbUri}`);
      await runSeed(mongodbUri);
    }

    server = await startNext(mongodbUri);
    console.log(`[lighthouse] Next escuchando en ${baseUrl}`);

    process.env.CHROME_PATH ||= chromium.executablePath();
    chrome = await launch({
      chromeFlags: [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });

    const routes = [...ROUTES];
    const detailPath = await discoverDetailPath(browser, baseUrl);

    if (detailPath) {
      routes.push({
        path: detailPath,
        key: '/deposit/orders/[id]',
        authenticated: true,
      });
    }

    const results = {};

    for (const route of routes) {
      const url = new URL(route.path, baseUrl).href;
      const samples = [];

      for (let run = 1; run <= RUNS; run += 1) {
        await prepareSession(browser, url);
        console.log(`[lighthouse] ${route.key} run ${run}/${RUNS}`);
        const { lhr, html, json } = await runLighthouse(url, chrome.port);
        const measurement = readLighthouseMetrics(lhr);
        samples.push(measurement);

        const slug = routeSlug(route.key);
        writeFileSync(join(reportsDir, `${slug}.report.html`), html);
        writeFileSync(join(reportsDir, `${slug}.report.json`), json);

        console.log(
          `[lighthouse] ${route.key}: LCP ${measurement.lcpMs} ms · CLS ${measurement.cls} · TBT ${measurement.tbtMs} ms · imágenes ${measurement.imageBytes} B (${measurement.imageCount}) · bf-cache ${measurement.bfCacheScore ?? 'n/a'} · score ${measurement.performanceScore}`,
        );
      }

      results[route.key] = {
        lcpMs: Math.round(median(samples.map((sample) => sample.lcpMs))),
        cls: Math.round(median(samples.map((sample) => sample.cls)) * 10_000) / 10_000,
        tbtMs: Math.round(median(samples.map((sample) => sample.tbtMs))),
        ttfbMs: Math.round(median(samples.map((sample) => sample.ttfbMs))),
        fcpMs: Math.round(median(samples.map((sample) => sample.fcpMs))),
        imageBytes: Math.round(median(samples.map((sample) => sample.imageBytes))),
        imageCount: Math.round(median(samples.map((sample) => sample.imageCount))),
        totalByteWeightBytes: Math.round(
          median(samples.map((sample) => sample.totalByteWeightBytes)),
        ),
        performanceScore: Math.round(median(samples.map((sample) => sample.performanceScore))),
        bfCacheScore: samples.every((sample) => sample.bfCacheScore === 1)
          ? 1
          : samples.every((sample) => sample.bfCacheScore === null)
            ? null
            : 0,
        bfCacheReasons: [...new Set(samples.flatMap((sample) => sample.bfCacheReasons ?? []))],
      };
    }

    const violations = [];

    for (const [route, budget] of Object.entries(budgets.routes)) {
      const result = results[route];

      if (!result) {
        violations.push(`Falta el resultado de ${route}.`);
        continue;
      }

      if (result.lcpMs > budget.lcpMs) {
        violations.push(`${route}: LCP ${result.lcpMs} ms > ${budget.lcpMs} ms.`);
      }
      if (result.cls > budget.cls) {
        violations.push(`${route}: CLS ${result.cls} > ${budget.cls}.`);
      }
      if (result.tbtMs > budget.tbtMs) {
        violations.push(`${route}: TBT ${result.tbtMs} ms > ${budget.tbtMs} ms.`);
      }
      if (typeof budget.imageBytes === 'number' && result.imageBytes > budget.imageBytes) {
        violations.push(
          `${route}: imágenes ${result.imageBytes} B > ${budget.imageBytes} B (${result.imageCount} request(s)).`,
        );
      }
      if (
        typeof budget.totalByteWeightBytes === 'number' &&
        result.totalByteWeightBytes > budget.totalByteWeightBytes
      ) {
        violations.push(
          `${route}: peso total ${result.totalByteWeightBytes} B > ${budget.totalByteWeightBytes} B.`,
        );
      }
      if (
        result.bfCacheScore !== 1 &&
        result.bfCacheReasons.some((reason) => /no-store/i.test(reason))
      ) {
        violations.push(
          `${route}: bf-cache bloqueado por Cache-Control: no-store (${result.bfCacheReasons.join(' | ')}).`,
        );
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      baseUrl,
      runs: RUNS,
      routes: results,
      violations,
    };

    writeFileSync(join(reportsDir, 'summary.json'), JSON.stringify(summary, null, 2));

    const lines = [
      '| Ruta | LCP | CLS | TBT | TTFB | Imágenes | Peso total | bf-cache | Score |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...Object.entries(results).map(
        ([route, result]) =>
          `| ${route} | ${result.lcpMs} ms | ${result.cls} | ${result.tbtMs} ms | ${result.ttfbMs} ms | ${(result.imageBytes / 1024).toFixed(1)} KB (${result.imageCount}) | ${(result.totalByteWeightBytes / 1024).toFixed(1)} KB | ${result.bfCacheScore ?? 'n/a'} | ${result.performanceScore} |`,
      ),
    ];

    console.log(`\n[lighthouse] Reportes en ${reportsDir}`);
    console.log(lines.join('\n'));

    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    }

    if (violations.length > 0) {
      console.error('\nPresupuesto de Lighthouse incumplido:');
      for (const violation of violations) console.error(` - ${violation}`);
      process.exitCode = 1;
    }
  } finally {
    browser?.disconnect();
    await chrome?.kill();
    await stopProcess(server);
    await mongo?.stop();
  }
}

main().catch((error) => {
  console.error('[lighthouse] Error:', error);
  process.exitCode = 1;
});
