/**
 * Tests for the experimental performance analysis.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzePerformance } from '../src/performance.js';
import { maskSource } from '../src/mask.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A file object shaped like the one loadPackage produces. */
const file = (path, text) => ({ path, text, ...maskSource(text) });

function createTestPlugin(files) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-test-'));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    const dirPath = fullPath.split('/').slice(0, -1).join('/');
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

test('analyzePerformance - calculates bundle size', () => {
  const dir = createTestPlugin({
    'package.json': JSON.stringify({ name: 'test', version: '1.0.0' }),
    'index.js': 'x'.repeat(1000),
    'client.js': 'y'.repeat(500),
  });

  const pkg = {
    dir,
    manifest: { name: 'test', version: '1.0.0' },
    entries: {},
    jsFiles: [file('index.js', 'x'.repeat(1000)), file('client.js', 'y'.repeat(500))],
  };

  const metrics = analyzePerformance(pkg);

  assert.ok(metrics.bundleSize, 'should have bundle size metrics');
  assert.ok(metrics.bundleSize.total > 0, 'should calculate total size');
  assert.equal(typeof metrics.score, 'number', 'should have numeric score');
  assert.ok(metrics.score >= 0 && metrics.score <= 100, 'score should be 0-100');
});

test('analyzePerformance - detects complexity', () => {
  const text = [
    'function complex() {',
    '  if (a) {',
    '    if (b) {',
    '      if (c) {',
    '        if (d) {',
    '        }',
    '      }',
    '    }',
    '  }',
    '  for (let i = 0; i < 100; i++) {',
    '    if (i % 2) {',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const metrics = analyzePerformance({
    dir: '/test',
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('complex.js', text)],
  });

  assert.ok(metrics.complexity, 'should have complexity metrics');
  assert.ok(metrics.complexity.totalFunctions > 0, 'should detect functions');
});

test('analyzePerformance - detects network calls', () => {
  const text = [
    "fetch('https://api.example.com/data');",
    "axios.get('https://analytics.example.com/track');",
    "fetch('http://insecure.example.com/data');",
  ].join('\n');
  const metrics = analyzePerformance({
    dir: '/test',
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('network.js', text)],
  });

  assert.ok(metrics.networkCalls, 'should have network metrics');
  assert.equal(metrics.networkCalls.total, 3, 'should detect 3 network calls');
  assert.ok(metrics.networkCalls.externalDomains.length >= 2, 'should detect external domains');
});

test('analyzePerformance - ignores network calls and DOM writes in comments', () => {
  const text = [
    '// fetch("https://api.example.com/old") and document.body.appendChild(x)',
    '/* el.innerHTML = userInput; */',
    'const harmless = 1;',
  ].join('\n');
  const metrics = analyzePerformance({
    dir: '/test',
    manifest: { name: 'test' },
    entries: { client: 'client.js' },
    jsFiles: [file('client.js', text)],
  });

  assert.equal(metrics.networkCalls.total, 0, 'comments are not requests');
  assert.equal(metrics.domImpact.domMutations, 0, 'comments are not DOM writes');
  assert.equal(metrics.domImpact.directBodyAccess, 0);
});

test('analyzePerformance - generates recommendations', () => {
  const metrics = analyzePerformance({
    dir: '/test',
    manifest: { name: 'test' },
    entries: { client: 'client.js' },
    jsFiles: [file('client.js', 'document.body.innerHTML = userInput;')],
  });

  assert.ok(Array.isArray(metrics.recommendations), 'should have recommendations array');
  assert.ok(metrics.recommendations.some((r) => r.issue.includes('body')), 'should recommend against body manipulation');
});

test('analyzePerformance - an empty analysis is not an excellent score', () => {
  const metrics = analyzePerformance({
    dir: '/test',
    manifest: { name: 'empty' },
    entries: {},
    jsFiles: [],
  });

  assert.equal(metrics.rating, 'insufficient-data');
  assert.equal(metrics.score, 0);
  assert.ok(metrics.recommendations.some((r) => r.issue.includes('No JavaScript files')));
});

test('analyzePerformance - long functions are measured in lines, not characters', () => {
  const manyLines = 'const filler = 1;\n'.repeat(120);
  const text = 'export function big() {\n' + manyLines + '}\nexport function small() { return 1; }\n';
  const metrics = analyzePerformance({
    dir: '/test',
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('long.js', text)],
  });

  assert.equal(metrics.complexity.longFunctions, 1, 'only the >100-line function counts');
});

test('analyzePerformance - marks the analysis as experimental', () => {
  const metrics = analyzePerformance({ dir: '/test', manifest: { name: 'test' }, entries: {}, jsFiles: [] });
  assert.equal(metrics.experimental, true);
  assert.ok(Array.isArray(metrics.limits) && metrics.limits.length > 0);
});
