import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeArtifact } from '../src/probe/environment/materialize.js';

function dir(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('materialize rejects an artifact with no local source', async (t) => {
  const target = dir(t, 'dsh-materialize-');
  await assert.rejects(materializeArtifact({ name: 'demo' }, target), (error) => error.code === 'ARTIFACT_MISSING');
  await assert.rejects(materializeArtifact({ name: 'demo', path: join(target, 'absent') }, target), (error) => error.code === 'ARTIFACT_MISSING');
});

test('materialize copies a directory and sanitises its name', async (t) => {
  const source = dir(t, 'dsh-materialize-src-');
  const target = dir(t, 'dsh-materialize-dst-');
  writeFileSync(join(source, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  const result = await materializeArtifact({ name: 'demo@1.0.0', path: source }, target);
  assert.equal(result.hostPath, join(target, 'demo_1.0.0'));
  assert.equal(result.containerPath, '/source/demo_1.0.0');
  assert.equal(result.installTarget, '/source/demo_1.0.0');
  assert.equal(readFileSync(join(result.hostPath, 'package.json'), 'utf8').includes('demo'), true);
});

test('materialize copies a tarball file and falls back to the basename', async (t) => {
  const source = dir(t, 'dsh-materialize-tar-');
  const target = dir(t, 'dsh-materialize-tar-out-');
  const tarball = join(source, 'demo-1.0.0.tgz');
  writeFileSync(tarball, 'tarball-bytes');
  const result = await materializeArtifact({ tarballPath: tarball }, target);
  assert.equal(result.hostPath, join(target, 'demo-1.0.0.tgz'));
  assert.equal(readFileSync(result.hostPath, 'utf8'), 'tarball-bytes');
});

test('materialize uses the directory basename when the artifact has no name', async (t) => {
  const parent = dir(t, 'dsh-materialize-parent-');
  const source = join(parent, 'plain-dir');
  const target = dir(t, 'dsh-materialize-noname-');
  mkdirSync(source);
  writeFileSync(join(source, 'index.js'), '');
  const result = await materializeArtifact({ path: source }, target);
  assert.equal(result.hostPath, join(target, 'plain-dir'));
});