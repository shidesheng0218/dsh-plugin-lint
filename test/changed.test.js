import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedFiles, packageRoots } from '../src/core/changed.js';

const BIN = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));

function write(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function git(root, args) {
  return execFileSync('git', ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', ...args], { cwd: root, encoding: 'utf8' });
}

test('packageRoots maps files to the nearest package and ignores files outside one', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-changed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'packages/a/package.json', { name: 'a' });
  write(root, 'packages/a/src/index.js', '');
  write(root, 'packages/b/package.json', { name: 'b' });
  write(root, 'README.md', '');
  const roots = packageRoots(['packages/a/src/index.js', 'packages/a/gone.js', 'README.md', 'packages/b/package.json'], root);
  assert.deepEqual(roots, [join(root, 'packages/a'), join(root, 'packages/b')].sort());
});

test('changedFiles and the CLI honour --changed and --staged in a git repo', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-changed-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'packages/a/package.json', { name: 'alpha', version: '1.0.0', main: 'index.js' });
  write(root, 'packages/a/index.js', 'export const a = 1;\n');
  write(root, 'packages/b/package.json', { name: 'beta', version: '1.0.0', main: 'index.js' });
  write(root, 'packages/b/index.js', 'export const b = 1;\n');
  write(root, '.gitignore', 'node_modules\n');
  git(root, ['init']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  write(root, 'packages/a/index.js', 'export const a = 2;\n');
  assert.deepEqual(changedFiles({ cwd: root }), ['packages/a/index.js']);
  assert.deepEqual(packageRoots(changedFiles({ cwd: root }), root), [join(root, 'packages/a')]);
  const changed = spawnSync(process.execPath, [BIN, '--changed', 'HEAD', '--quiet', '--no-color'], { cwd: root, encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /alpha:/);
  assert.doesNotMatch(changed.stdout, /beta:/);

  write(root, 'packages/b/index.js', 'export const b = 2;\n');
  git(root, ['add', 'packages/b/index.js']);
  const staged = spawnSync(process.execPath, [BIN, '--staged', '--quiet', '--no-color'], { cwd: root, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.stdout, /beta:/);
  assert.doesNotMatch(staged.stdout, /alpha:/);
});