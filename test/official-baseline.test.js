import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/e2e-official.mjs', import.meta.url));

function fixture(t, packages = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-official-baseline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, manifest] of Object.entries(packages)) {
    const pkg = join(dir, name);
    mkdirSync(pkg, { recursive: true });
    if (manifest !== null) {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...manifest }));
      writeFileSync(join(pkg, 'index.js'), 'export function apply() {}');
    }
  }
  return dir;
}

function run(dir, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, dir, ...extra], { encoding: 'utf8' });
}

test('an empty official baseline fails instead of reporting a vacuous PASS', (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no packages|0 packages|no targets/i);
});

test('a package that cannot be loaded is an explicit baseline failure', (t) => {
  const result = run(fixture(t, { broken: null }), ['--expect', '1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /failed|cannot|error/i);
});

test('the checked package count must equal --expect', (t) => {
  const result = run(fixture(t, { demo: {} }), ['--expect', '2']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /packages checked: 1/);
  assert.match(result.stderr, /expected 2|expected: 2/i);
});

test('one successfully checked package can satisfy --expect 1', (t) => {
  const result = run(fixture(t, { demo: {} }), ['--expect', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /packages checked: 1/);
  assert.match(result.stdout, /PASS/);
});
