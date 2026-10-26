/**
 * Tests for performance analysis
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzePerformance } from '../src/performance.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    'client.js': 'y'.repeat(500)
  });

  const pkg = {
    dir,
    manifest: { name: 'test', version: '1.0.0' },
    entries: {},
    jsFiles: [
      { path: 'index.js', text: 'x'.repeat(1000), bytes: 1000, lineStarts: [0] },
      { path: 'client.js', text: 'y'.repeat(500), bytes: 500, lineStarts: [0] }
    ]
  };

  const metrics = analyzePerformance(pkg);
  
  assert.ok(metrics.bundleSize, 'Should have bundle size metrics');
  assert.ok(metrics.bundleSize.total > 0, 'Should calculate total size');
  assert.equal(typeof metrics.score, 'number', 'Should have numeric score');
  assert.ok(metrics.score >= 0 && metrics.score <= 100, 'Score should be 0-100');
});

test('analyzePerformance - detects complexity', () => {
  const pkg = {
    dir: '/test',
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [
      {
        path: 'complex.js',
        text: `
function complex() {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          // Deep nesting
        }
      }
    }
  }
  for (let i = 0; i < 100; i++) {
    if (i % 2) {
      // More complexity
    }
  }
}
        `.trim(),
        bytes: 200,
        lineStarts: Array.from({ length: 20 }, (_, i) => i * 50)
      }
    ]
  };

  const metrics = analyzePerformance(pkg);
  
  assert.ok(metrics.complexity, 'Should have complexity metrics');
  assert.ok(metrics.complexity.totalFunctions > 0, 'Should detect functions');
});

test('analyzePerformance - detects network calls', () => {
  const pkg = {
    dir: '/test',
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [
      {
        path: 'network.js',
        text: `
fetch('https://api.example.com/data');
axios.get('https://analytics.example.com/track');
fetch('http://insecure.example.com/data');
        `.trim(),
        bytes: 150,
        lineStarts: [0, 45, 95]
      }
    ]
  };

  const metrics = analyzePerformance(pkg);
  
  assert.ok(metrics.networkCalls, 'Should have network metrics');
  assert.equal(metrics.networkCalls.total, 3, 'Should detect 3 network calls');
  assert.ok(metrics.networkCalls.externalDomains.length >= 2, 'Should detect external domains');
});

test('analyzePerformance - generates recommendations', () => {
  const pkg = {
    dir: '/test',
    manifest: { name: 'test' },
    entries: { client: 'client.js' },
    jsFiles: [
      {
        path: 'client.js',
        text: 'document.body.innerHTML = userInput;',
        bytes: 50,
        lineStarts: [0]
      }
    ]
  };

  const metrics = analyzePerformance(pkg);
  
  assert.ok(Array.isArray(metrics.recommendations), 'Should have recommendations array');
  assert.ok(metrics.recommendations.some(r => r.issue.includes('body')), 'Should recommend against body manipulation');
});

console.log('✅ All performance tests passed');
