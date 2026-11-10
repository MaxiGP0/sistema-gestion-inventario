/**
 * Pruebas del reporte de Web Vitals:
 * - sólo se envían LCP, INP, CLS y TTFB;
 * - la ruta se normaliza y no arrastra query/hash;
 * - la clase de dispositivo sale del ancho, sin user agent;
 * - el release viaja como atributo, sin datos de la sesión;
 * - CLS se emite como ratio y las métricas temporales como milisegundos.
 *
 * Ejecutar con: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  recordWebVital,
  setMetricsSinkForTests,
  type MetricsSink,
} from '../lib/observability/metrics';
import {
  deviceClassForWidth,
  toWebVitalReport,
  type WebVitalReport,
} from '../lib/observability/web-vitals';

interface CapturedMetric {
  name: string;
  value: number;
  options?: {
    unit?: string;
    attributes?: Record<string, string | number | boolean>;
  };
}

function captureDistribution(): { calls: CapturedMetric[]; restore: () => void } {
  const calls: CapturedMetric[] = [];
  const sink: MetricsSink = {
    count() {},
    gauge() {},
    distribution: (name, value, options) => calls.push({ name, value, options }),
  };

  setMetricsSinkForTests(sink);

  return {
    calls,
    restore: () => setMetricsSinkForTests(null),
  };
}

test('normaliza las métricas soportadas y descarta FCP u otras', () => {
  const lcp = toWebVitalReport(
    {
      name: 'LCP',
      value: 1234.6,
      rating: 'good',
      navigationType: 'navigate',
      navigationURL: 'https://app.sgi.test/orders/64f1234567890abcdef12345?token=secreto#top',
    },
    { width: 390, release: 'abc123' },
  );

  assert.deepEqual(lcp, {
    name: 'LCP',
    value: 1235,
    rating: 'good',
    route: '/orders/[id]',
    deviceClass: 'mobile',
    release: 'abc123',
    navigationType: 'navigate',
    unit: 'millisecond',
  });

  assert.equal(
    toWebVitalReport({ name: 'FCP', value: 100 }, { width: 390, release: 'abc123' }),
    null,
  );
  assert.equal(
    toWebVitalReport({ name: 'LCP', value: Number.NaN }, { width: 390, release: 'abc123' }),
    null,
  );
  assert.equal(
    toWebVitalReport({ name: 'LCP', value: -1 }, { width: 390, release: 'abc123' }),
    null,
  );
});

test('usa pathname cuando no hay navigationURL y redondea CLS como ratio', () => {
  const cls = toWebVitalReport(
    { name: 'CLS', value: 0.012345, rating: 'needs-improvement' },
    { pathname: '/deposit/orders/64f1234567890abcdef12345?debug=1', width: 900, release: 'r1' },
  );

  assert.equal(cls?.value, 0.0123);
  assert.equal(cls?.route, '/deposit/orders/[id]');
  assert.equal(cls?.deviceClass, 'tablet');
  assert.equal(cls?.unit, 'ratio');

  const unknown = toWebVitalReport(
    { name: 'INP', value: 250, rating: 'inventado', navigationType: 'otro' },
    { pathname: '/', width: 1280, release: 'r1' },
  );

  assert.equal(unknown?.rating, 'unknown');
  assert.equal(unknown?.navigationType, 'unknown');
  assert.equal(unknown?.deviceClass, 'desktop');
});

test('clasifica dispositivos por ancho sin leer el user agent', () => {
  assert.equal(deviceClassForWidth(360), 'mobile');
  assert.equal(deviceClassForWidth(767), 'mobile');
  assert.equal(deviceClassForWidth(768), 'tablet');
  assert.equal(deviceClassForWidth(1023), 'tablet');
  assert.equal(deviceClassForWidth(1024), 'desktop');
  assert.equal(deviceClassForWidth(Number.NaN), 'mobile');
});

test('emite web.vitals.* con ruta, dispositivo y release, sin PII', () => {
  const captured = captureDistribution();

  try {
    const report: WebVitalReport = {
      name: 'LCP',
      value: 1800,
      rating: 'good',
      route: '/orders/[id]',
      deviceClass: 'mobile',
      release: 'commit-sha',
      navigationType: 'navigate',
      unit: 'millisecond',
    };

    recordWebVital(report);

    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].name, 'web.vitals.lcp');
    assert.equal(captured.calls[0].value, 1800);
    assert.equal(captured.calls[0].options?.unit, 'millisecond');
    assert.deepEqual(captured.calls[0].options?.attributes, {
      'web.vital': 'LCP',
      'web.vital.rating': 'good',
      'web.vital.navigation_type': 'navigate',
      'http.route': '/orders/[id]',
      'device.class': 'mobile',
      release: 'commit-sha',
    });

    const serialized = JSON.stringify(captured.calls[0]);
    assert.ok(!serialized.includes('token'));
    assert.ok(!serialized.includes('userAgent'));
    assert.ok(!serialized.includes('userId'));
  } finally {
    captured.restore();
  }
});
