import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lint-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function packageAt(root, name, files) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function errorPackage(root) {
  return packageAt(root, 'error-plugin', {
    'package.json': { name: 'error-plugin', version: '1.0.0', main: 'index.js' },
    'index.js': 'export function apply(ctx) { ctx.session.append("demo/custom", {}); }',
  });
}

function warnPackage(root) {
  return packageAt(root, 'warn-plugin', {
    'package.json': {
      name: 'warn-plugin', version: '1.0.0', main: 'index.js',
      exports: { '.': './index.js', './client': './client.js' },
      dsh: { client: { platform: 'web' } },
    },
    'index.js': 'export function apply() {}',
    'client.js': 'import { Button } from "@deepseek-ai/dsh-client-ui-primitives"; window.__ModuleLoader__.load({ id: "warn-plugin", factory: () => ({}) });',
  });
}

function run(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

test('--version, --rules and --explain expose the machine contract', (t) => {
  const root = workspace(t);
  const version = run(root, ['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  const rules = run(root, ['--rules']);
  assert.equal(rules.status, 0);
  assert.match(rules.stdout, /E6\s+error/);
  assert.equal(rules.stdout.trim().split('\n').length, 12);
  const explain = run(root, ['--explain', 'E6']);
  assert.equal(explain.status, 0);
  assert.match(explain.stdout, /peerDependencies|peer range/);
  assert.equal(run(root, ['--explain', 'NOPE']).status, 2);
});

test('--format github emits annotations and --fail-on controls the exit code', (t) => {
  const root = workspace(t);
  const dir = errorPackage(root);
  const annotations = run(root, [dir, '--format', 'github']);
  assert.equal(annotations.status, 0);
  assert.match(annotations.stdout, /^::error file=.*index\.js,line=1,title=E1 /m);
  assert.equal(run(root, [dir, '--exit-code']).status, 1);
  const warn = warnPackage(root);
  assert.equal(run(root, [warn, '--fail-on', 'warn']).status, 1);
  assert.equal(run(root, [warn, '--fail-on', 'error']).status, 0);
});

test('--format junit and json-envelope are parseable', (t) => {
  const root = workspace(t);
  const dir = errorPackage(root);
  const junit = run(root, [dir, '--format', 'junit']);
  assert.equal(junit.status, 0);
  assert.match(junit.stdout, /<testsuite name="error-plugin"/);
  assert.match(junit.stdout, /<failure type="E1"/);
  const envelope = run(root, [dir, '--format', 'json-envelope']);
  const parsed = JSON.parse(envelope.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(Array.isArray(parsed.reports), true);
  assert.equal(parsed.reports[0].target.name, 'error-plugin');
});

test('SARIF uses relative paths, per-rule help and partial fingerprints', (t) => {
  const root = workspace(t);
  const dir = errorPackage(root);
  const sarif = JSON.parse(run(root, [dir, '--format', 'sarif']).stdout);
  const result = sarif.runs[0].results.find((entry) => entry.ruleId === 'E1');
  assert.ok(result);
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'error-plugin/index.js');
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uriBaseId, '%SRCROOT%');
  assert.match(result.partialFingerprints['dshPluginLint/v1'], /^sha256:[0-9a-f]{64}$/);
  assert.match(sarif.runs[0].tool.driver.rules.find((rule) => rule.id === 'E1').helpUri, /docs\/rules\/E1\.md$/);
});

test('a baseline suppresses findings and --write-baseline records them', (t) => {
  const root = workspace(t);
  const dir = errorPackage(root);
  const baselinePath = join(root, 'baseline.json');
  assert.equal(run(root, [dir, '--exit-code']).status, 1);
  const write = run(root, [dir, '--write-baseline', baselinePath]);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(existsSync(baselinePath), true);
  assert.equal(run(root, [dir, '--baseline', baselinePath, '--exit-code']).status, 0);
  const pruned = run(root, [dir, '--baseline', baselinePath, '--prune']);
  assert.equal(pruned.status, 0);
});

test('--output-file writes the report instead of stdout', (t) => {
  const root = workspace(t);
  const dir = errorPackage(root);
  const out = join(root, 'out', 'report.json');
  const result = run(root, [dir, '--format', 'json-envelope', '-o', out]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).reports.length, 1);
});

test('--init writes a workflow and a starter baseline', (t) => {
  const root = workspace(t);
  const result = run(root, ['--init', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, '.github/workflows/dsh-plugin-lint.yml')), true);
  assert.equal(existsSync(join(root, '.dsh-plugin-lint-baseline.json')), true);
  assert.equal(run(root, ['--init', root]).status, 2, 'refuses to overwrite without --force');
});