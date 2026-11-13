import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractTarball } from '../src/core/tarball.js';
import { detectPackageManager, extractTarballTo, packDirectory } from '../src/core/pack.js';

const BIN = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));

const probeEnv = { ...process.env };
delete probeEnv.NODE_V8_COVERAGE;

function workspace(t, prefix = 'dsh-pack-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function demoPackage(root, name = 'pack-demo') {
  write(root, 'package.json', { name, version: '1.0.0', main: 'index.js', files: ['index.js'] });
  write(root, 'index.js', 'export const x = 1;\n');
  return root;
}

function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write((body.length.toString(8).padStart(11, '0') + '\0'), 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

test('detectPackageManager reads lockfiles', (t) => {
  const root = workspace(t);
  assert.equal(detectPackageManager(root), 'npm');
  write(root, 'pnpm-lock.yaml', '');
  assert.equal(detectPackageManager(root), 'pnpm');
  const yarn = workspace(t);
  write(yarn, 'yarn.lock', '');
  assert.equal(detectPackageManager(yarn), 'yarn');
  const bun = workspace(t);
  write(bun, 'bun.lockb', '');
  assert.equal(detectPackageManager(bun), 'bun');
});

test('packDirectory produces a tarball that extracts to the package root', (t) => {
  const root = demoPackage(workspace(t));
  const packed = packDirectory(root);
  assert.equal(packed.manager, 'npm');
  const extracted = extractTarballTo(packed.tarball);
  t.after(packed.cleanup);
  t.after(extracted.cleanup);
  assert.equal(JSON.parse(readFileSync(join(extracted.root, 'package.json'), 'utf8')).name, 'pack-demo');
  assert.equal(readFileSync(join(extracted.root, 'index.js'), 'utf8').includes('export'), true);
});

test('extractTarball rejects a traversal entry', () => {
  const buffer = gzipSync(Buffer.concat([tarEntry('../evil.js', Buffer.from('x')), Buffer.alloc(1024)]));
  assert.throws(() => extractTarball(buffer, mkdtempSync(join(tmpdir(), 'dsh-tar-'))), /escapes the extraction directory/);
});

test('pnpm pack produces a tarball without running lifecycle scripts', (t) => {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', env: probeEnv });
  if (probe.status !== 0) return t.skip('pnpm is not installed');
  const root = demoPackage(workspace(t));
  write(root, 'package.json', {
    name: 'pack-demo',
    version: '1.0.0',
    files: ['index.js'],
    scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'prepack-ran\',\'x\')"' },
  });
  const packed = packDirectory(root, { manager: 'pnpm' });
  t.after(packed.cleanup);
  assert.equal(packed.manager, 'pnpm');
  assert.equal(existsSync(join(root, 'prepack-ran')), false, 'prepack must not run while linting');
  const extracted = extractTarballTo(packed.tarball);
  t.after(extracted.cleanup);
  assert.equal(JSON.parse(readFileSync(join(extracted.root, 'package.json'), 'utf8')).name, 'pack-demo');
});

test('the CLI refuses --pack in the author phase', (t) => {
  const root = demoPackage(workspace(t));
  const result = spawnSync(process.execPath, [BIN, '--pack', '--phase', 'author'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /use --phase publish/);
});

test('--from-npm lints only the published spec, not the current directory', (t) => {
  const published = demoPackage(workspace(t, 'dsh-npm-src-'), 'from-npm-demo');
  const packed = packDirectory(published);
  t.after(packed.cleanup);
  const bin = workspace(t, 'dsh-fake-bin-');
  const fakeNpm = join(bin, 'npm');
  writeFileSync(fakeNpm, [
    '#!/bin/sh',
    'dest=""',
    'prev=""',
    'for arg in "$@"; do',
    '  [ "$prev" = "--pack-destination" ] && dest="$arg"',
    '  prev="$arg"',
    'done',
    'cp "$FIXTURE_TGZ" "$dest/from-npm-demo-1.0.0.tgz"',
    'echo from-npm-demo-1.0.0.tgz',
    '',
  ].join('\n'));
  chmodSync(fakeNpm, 0o755);
  const cwd = demoPackage(workspace(t, 'dsh-cwd-'), 'cwd-demo');
  const result = spawnSync(process.execPath, [BIN, '--from-npm', 'from-npm-demo@1.0.0', '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_TGZ: packed.tarball },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(Array.isArray(report), false, 'the current directory must not be linted too');
  assert.equal(report.target.name, 'from-npm-demo');
  assert.equal(report.target.source, 'npm:from-npm-demo@1.0.0');
});

test('the CLI lints a .tgz and records the source', (t) => {
  const root = demoPackage(workspace(t));
  const packed = packDirectory(root);
  t.after(packed.cleanup);
  const result = spawnSync(process.execPath, [BIN, packed.tarball, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.target.name, 'pack-demo');
  assert.match(report.target.source, /^tarball:/);
});

test('the CLI --pack packs the local tree and lints the artifact', (t) => {
  const root = demoPackage(workspace(t));
  const result = spawnSync(process.execPath, [BIN, '--pack', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.target.source, 'pack:npm');
  assert.equal(report.target.name, 'pack-demo');
});