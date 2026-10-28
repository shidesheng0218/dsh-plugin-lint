import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));

test('a linter input failure exits 2 rather than producing a passing report', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lint-cli-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{not-json');
  const result = spawnSync(process.execPath, [CLI, dir, '--json', '--exit-code'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /dsh-plugin-lint:/);
});
