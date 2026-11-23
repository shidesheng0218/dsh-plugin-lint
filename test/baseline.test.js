import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBaseline,
  createBaseline,
  fingerprint,
  normalizeEvidence,
  pruneBaseline,
  readBaseline,
  writeBaseline,
} from '../src/core/baseline.js';

function report(findings, name = 'demo') {
  return {
    target: { name, version: '1.0.0', path: '/tmp/' + name },
    checks: 12,
    findings,
    summary: {
      error: findings.filter((f) => f.level === 'error').length,
      warn: findings.filter((f) => f.level === 'warn').length,
      info: findings.filter((f) => f.level === 'info').length,
    },
    limits: [],
  };
}

const finding = (overrides = {}) => ({
  rule: 'E1', level: 'error', title: 'bad', file: 'index.js', line: 3,
  message: 'm', evidence: 'session.append("demo/type", ...)', doc: 'd', ...overrides,
});

test('fingerprints are stable across line and whitespace changes', () => {
  assert.equal(fingerprint(finding()), fingerprint(finding({ line: 99 })));
  assert.equal(fingerprint(finding()), fingerprint(finding({ evidence: '  session.append("demo/type",   ...) ' })));
  assert.notEqual(fingerprint(finding()), fingerprint(finding({ rule: 'W1' })));
  assert.equal(normalizeEvidence(' a\n b\t'), 'a b');
});

test('fingerprints include package identity when supplied', () => {
  assert.equal(fingerprint(finding(), 'package-a'), fingerprint(finding({ line: 99 }), 'package-a'));
  assert.notEqual(fingerprint(finding(), 'package-a'), fingerprint(finding(), 'package-b'));
  assert.notEqual(fingerprint(finding()), fingerprint(finding(), 'package-a'));
});

test('createBaseline deduplicates and records the ruleset identity', () => {
  const baseline = createBaseline([report([finding(), finding({ line: 9 }), finding({ rule: 'W1', level: 'warn', evidence: 'x' })])], { generatedAt: '2026-11-13T00:00:00.000Z' });
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.findings.length, 2);
  assert.match(baseline.ruleset.hash, /^[0-9a-f]{64}$/);
  assert.equal(baseline.ruleset.rules.includes('E6'), true);
});

test('baselines isolate identical findings by package', () => {
  const a = report([finding()], 'package-a');
  const b = report([finding()], 'package-b');
  const fromA = createBaseline([a]);
  assert.equal(applyBaseline([a], fromA).suppressed, 1);
  assert.equal(applyBaseline([b], fromA).suppressed, 0);

  const both = createBaseline([a, b]);
  assert.equal(both.findings.length, 2);
  assert.deepEqual(both.findings.map((entry) => entry.package), ['package-a', 'package-b']);
  assert.equal(applyBaseline([a, b], both).suppressed, 2);
  const pruned = pruneBaseline(both, [a]);
  assert.deepEqual(pruned.findings.map((entry) => entry.package), ['package-a']);
});

test('legacy unscoped baselines work for one package and reject multiple reports', () => {
  const legacy = {
    schemaVersion: 1,
    findings: [{ fingerprint: fingerprint(finding()), rule: 'E1' }],
  };
  assert.equal(applyBaseline([report([finding()], 'package-a')], legacy).suppressed, 1);
  assert.throws(
    () => applyBaseline([report([finding()], 'package-a'), report([finding()], 'package-b')], legacy),
    /single package.*regenerate/,
  );
  assert.throws(
    () => pruneBaseline(legacy, [report([finding()], 'package-a'), report([finding()], 'package-b')]),
    /single package.*regenerate/,
  );
});

test('applyBaseline filters findings and recomputes summaries', () => {
  const r = report([finding(), finding({ rule: 'W1', level: 'warn', evidence: 'keep' })]);
  const baseline = createBaseline([r]);
  const applied = applyBaseline([r], baseline, { path: 'b.json' });
  assert.equal(applied.suppressed, 2);
  assert.equal(applied.reports[0].findings.length, 0);
  assert.deepEqual(applied.reports[0].summary, { error: 0, warn: 0, info: 0 });
  assert.equal(applied.reports[0].baseline.suppressed, 2);
});

test('pruneBaseline keeps only entries that still occur', () => {
  const before = report([finding(), finding({ rule: 'W1', level: 'warn', evidence: 'gone' })]);
  const baseline = createBaseline([before]);
  const after = report([finding({ line: 20 })]);
  const pruned = pruneBaseline(baseline, [after]);
  assert.equal(pruned.findings.length, 1);
  assert.equal(pruned.findings[0].rule, 'E1');
});

test('baseline files round-trip and reject malformed input', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'baseline.json');
  const baseline = createBaseline([report([finding()])]);
  writeBaseline(path, baseline);
  assert.deepEqual(readBaseline(path), baseline);
  writeFileSync(path, '{"schemaVersion":1,"findings":{}}');
  assert.throws(() => readBaseline(path), /not a dsh-plugin-lint baseline/);
  writeFileSync(path, '{"schemaVersion":1,"findings":[{"fingerprint":"sha256:x","rule":"E1","package":""}]}');
  assert.throws(() => readBaseline(path), /package/);
});