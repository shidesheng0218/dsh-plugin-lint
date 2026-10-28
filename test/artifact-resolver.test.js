import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArtifact, resolveArtifact, verifyIntegrity } from '../src/probe/artifact-resolver.js';

const bytes = Buffer.from('real tarball bytes');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const tarballUrl = 'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz';

function metadata() {
  return {
    'dist-tags': { latest: '1.2.3', beta: '1.2.3' },
    versions: {
      '1.2.3': { version: '1.2.3', dist: { tarball: tarballUrl, integrity } },
    },
  };
}

function registryFixture(t) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === tarballUrl) return new Response(bytes, { status: 200 });
    return new Response(JSON.stringify(metadata()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('registry latest resolves once to an exact install target with integrity', async () => {
  const fetchImpl = registryFixture();
  const artifact = await resolveArtifact('demo@latest', { fetchImpl });
  assert.equal(artifact.requestedVersion, 'latest');
  assert.equal(artifact.resolvedVersion, '1.2.3');
  assert.equal(artifact.installTarget, 'demo@1.2.3');
  assert.equal(artifact.integrity, integrity);
  assert.equal(artifact.tarballUrl, tarballUrl);
  assert.equal(fetchImpl.calls.length, 1);
});

test('an exact target object is pinned and its expected integrity is enforced', async () => {
  const fetchImpl = registryFixture();
  const artifact = await resolveArtifact({ name: 'demo', version: '1.2.3', integrity }, { fetchImpl });
  assert.equal(artifact.resolvedVersion, '1.2.3');
  assert.equal(artifact.requestedVersion, '1.2.3');
  await assert.rejects(
    resolveArtifact({ name: 'demo', version: '1.2.3', integrity: 'sha512-AAAA' }, { fetchImpl }),
    (error) => error.code === 'ARTIFACT_INTEGRITY_MISMATCH',
  );
});

test('version ranges are unsupported and never fall back to latest', async () => {
  const fetchImpl = registryFixture();
  for (const range of ['^1.2.3', '~1.2.3', '*', '>=1.0.0', '1.2']) {
    await assert.rejects(resolveArtifact({ name: 'demo', version: range }, { fetchImpl }), (error) => error.code === 'ARTIFACT_SPEC_UNSUPPORTED');
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('registry HTTP and metadata failures are infrastructure errors', async () => {
  await assert.rejects(resolveArtifact('demo', { fetchImpl: async () => new Response('no', { status: 503 }) }), (error) => error.code === 'ARTIFACT_REGISTRY_ERROR');
  await assert.rejects(resolveArtifact('demo', { fetchImpl: async () => new Response('{}', { status: 200 }) }), (error) => error.code === 'ARTIFACT_REGISTRY_ERROR');
});

test('download verifies SRI before writing and leaves no file on mismatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifact-download-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const artifact = await resolveArtifact('demo', { fetchImpl: registryFixture() });
  const destination = join(dir, 'demo.tgz');
  const downloaded = await downloadArtifact(artifact, { fetchImpl: registryFixture(), destination });
  assert.equal(downloaded.tarballPath, destination);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(verifyIntegrity(bytes, integrity), true);
  assert.equal(verifyIntegrity(Buffer.from('tampered'), integrity), false);
  const missing = join(dir, 'missing.tgz');
  await assert.rejects(
    downloadArtifact({ ...artifact, integrity: 'sha512-AAAA' }, { fetchImpl: registryFixture(), destination: missing }),
    (error) => error.code === 'ARTIFACT_INTEGRITY_MISMATCH',
  );
  assert.equal(existsSync(missing), false);
});

test('local artifacts use manifest versions and a deterministic source digest', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifact-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'local-demo', version: '2.0.0' }));
  writeFileSync(join(dir, 'z.js'), 'z');
  writeFileSync(join(dir, 'a.js'), 'a');
  const first = await resolveArtifact(dir);
  const second = await resolveArtifact(dir);
  assert.equal(first.resolvedVersion, '2.0.0');
  assert.equal(first.local, true);
  assert.equal(first.integrity, undefined);
  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.match(first.sourceDigest, /^[0-9a-f]{64}$/);
});
