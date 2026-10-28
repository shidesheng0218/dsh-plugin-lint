import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probePackage } from '../src/probe/probe.js';
import { readInstalledArtifact } from '../src/probe/installed-artifact.js';
import { probeFixture } from './probe-helpers.js';

test('a completed probe verifies the loaded version and reproduces the exact target', async (t) => {
  const fixture = probeFixture(t);
  const observation = await probePackage({ ...fixture, composition: 'headless' });
  assert.equal(observation.outcome, 'completed');
  assert.equal(observation.result.status, 'active');
  assert.equal(observation.loadedVersion, '1.2.3');
  assert.match(observation.reproduce.command, /demo@1\.2\.3/);
  assert.match(observation.reproduce.command, /--unsafe-host/);
  assert.equal(fixture.environment.calls.destroy, 1);
});

test('a successful install with no manifest is ARTIFACT_MISSING, not active', async (t) => {
  const fixture = probeFixture(t, { install: 'missing' });
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'error');
  assert.equal(observation.error.code, 'ARTIFACT_MISSING');
  assert.equal(observation.result, undefined);
  assert.equal(fixture.environment.calls.destroy, 1);
});

test('resolvedVersion and loadedVersion drift is VERSION_MISMATCH', async (t) => {
  const fixture = probeFixture(t, { loadedVersion: '1.2.4' });
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'error');
  assert.equal(observation.error.code, 'VERSION_MISMATCH');
  assert.equal(observation.result, undefined);
});

test('a failed install process with a real artifact is ok-with-warnings', async (t) => {
  const fixture = probeFixture(t, { install: 'warning' });
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'completed');
  assert.equal(observation.install, 'ok-with-warnings');
  assert.equal(observation.result.status, 'active');
});

test('web uses the shared non-waiting failure classifier', async (t) => {
  const fixture = probeFixture(t, { bootText: '1 plugins did not activate:\ndemo (demo): configuration rejected\n' });
  const observation = await probePackage({ ...fixture, composition: 'web' });
  assert.equal(observation.outcome, 'completed');
  assert.equal(observation.result.status, 'inactive-error');
});

test('desktop DSH on Docker is unsupported before any install command', async (t) => {
  const fixture = probeFixture(t, { isolation: 'docker', loadedVersion: 'desktop' });
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'error');
  assert.equal(observation.error.code, 'ISOLATION_UNSUPPORTED');
  assert.equal(fixture.environment.calls.install, 0);
  assert.equal(fixture.environment.calls.destroy, 1);
});

test('readInstalledArtifact returns the real manifest and fails closed when absent', (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-installed-artifact-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const manifest = join(profile, 'node_modules', 'demo', 'package.json');
  mkdirSync(join(profile, 'node_modules', 'demo'), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ name: 'demo', version: '1.2.3' }));
  assert.deepEqual(readInstalledArtifact(profile, 'demo'), { version: '1.2.3', path: join(profile, 'node_modules', 'demo') });
  assert.throws(() => readInstalledArtifact(profile, 'missing'), (error) => error.code === 'ARTIFACT_MISSING');
});
