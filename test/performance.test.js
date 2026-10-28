import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzePerformance } from '../src/performance.js';
import { loadPackage } from '../src/load.js';

function loadedPackage(t, files, manifest = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', main: 'index.js', ...manifest }));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return loadPackage(dir);
}

test('analyzePerformance calculates bundle size from the real package', (t) => {
  const pkg = loadedPackage(t, {
    'index.js': 'x'.repeat(1000),
    'client.js': 'y'.repeat(500),
  });
  const metrics = analyzePerformance(pkg);
  assert.ok(metrics.bundleSize.total > 0);
  assert.equal(typeof metrics.score, 'number');
  assert.ok(metrics.score >= 0 && metrics.score <= 100);
});

test('analyzePerformance includes index.js for files **/*', (t) => {
  const pkg = loadedPackage(t, { 'index.js': 'export const answer = 42;' }, { files: ['**/*'] });
  const metrics = analyzePerformance(pkg);
  assert.equal(metrics.bundleSize.fileCount, 2);
  assert.equal(metrics.bundleSize.largest.some((file) => file.path === 'index.js'), true);
});

test('analyzePerformance detects functions from real files', (t) => {
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
  const metrics = analyzePerformance(loadedPackage(t, { 'index.js': text }));
  assert.ok(metrics.complexity.totalFunctions > 0);
});

test('analyzePerformance does not count braces inside strings as deep nesting', (t) => {
  const metrics = analyzePerformance(loadedPackage(t, { 'index.js': 'const s = "{{{{";\n' }));
  assert.equal(metrics.complexity.deepNesting, 0);
});

test('analyzePerformance detects network calls', (t) => {
  const text = [
    "fetch('https://api.example.com/data');",
    "axios.get('https://analytics.example.com/track');",
    "fetch('http://insecure.example.com/data');",
  ].join('\n');
  const metrics = analyzePerformance(loadedPackage(t, { 'index.js': text }));
  assert.equal(metrics.networkCalls.total, 3);
  assert.ok(metrics.networkCalls.externalDomains.length >= 2);
});

test('analyzePerformance ignores network calls and DOM writes in comments', (t) => {
  const text = [
    '// fetch("https://api.example.com/old") and document.body.appendChild(x)',
    '/* el.innerHTML = userInput; */',
    'const harmless = 1;',
  ].join('\n');
  const metrics = analyzePerformance(loadedPackage(t, { 'client.js': text }, { dsh: { client: { platform: 'web' } } }));
  assert.equal(metrics.networkCalls.total, 0);
  assert.equal(metrics.domImpact.domMutations, 0);
  assert.equal(metrics.domImpact.directBodyAccess, 0);
});

test('analyzePerformance generates recommendations', (t) => {
  const metrics = analyzePerformance(loadedPackage(t, { 'client.js': 'document.body.innerHTML = userInput;' }, { dsh: { client: { platform: 'web' } } }));
  assert.ok(metrics.recommendations.some((recommendation) => recommendation.issue.includes('body')));
});

test('analyzePerformance gives an empty analysis insufficient data', (t) => {
  const metrics = analyzePerformance(loadedPackage(t, {}));
  assert.equal(metrics.rating, 'insufficient-data');
  assert.equal(metrics.score, 0);
  assert.ok(metrics.recommendations.some((recommendation) => recommendation.issue.includes('No JavaScript files')));
});

test('analyzePerformance measures long functions in lines', (t) => {
  const manyLines = 'const filler = 1;\n'.repeat(120);
  const text = 'export function big() {\n' + manyLines + '}\nexport function small() { return 1; }\n';
  const metrics = analyzePerformance(loadedPackage(t, { 'index.js': text }));
  assert.equal(metrics.complexity.longFunctions, 1);
});

test('analyzePerformance is experimental schema v2 with limits', (t) => {
  const metrics = analyzePerformance(loadedPackage(t, {}));
  assert.equal(metrics.schemaVersion, 2);
  assert.equal(metrics.experimental, true);
  assert.ok(Array.isArray(metrics.limits) && metrics.limits.length > 0);
});
