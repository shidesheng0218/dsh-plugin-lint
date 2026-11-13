import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatProfileScan, installedBundles, profileRuntimeVersion, scanProfile } from '../src/core/profile-scan.js';

const BIN = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));

function write(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', { name: 'profile', dsh: { profile: { bundles: ['alpha', '@scope/beta', 'gamma', 'delta'] } } });
  write(root, 'node_modules/@deepseek-ai/dsh-app-boot/package.json', { name: '@deepseek-ai/dsh-app-boot', version: '0.2.2-rc.1' });
  write(root, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.3.0' } });
  write(root, 'node_modules/@scope/beta/package.json', { name: '@scope/beta', version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } });
  write(root, 'node_modules/gamma/package.json', { name: 'gamma', version: '3.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } });
  write(root, 'node_modules/delta/package.json', { name: 'delta', version: '4.0.0' });
  return root;
}

test('scanProfile reads the runtime and classifies every installed bundle', (t) => {
  const root = profile(t);
  assert.equal(profileRuntimeVersion(root), '0.2.2-rc.1');
  assert.deepEqual(installedBundles(root), ['alpha', '@scope/beta', 'gamma', 'delta']);
  const scan = scanProfile(root);
  assert.equal(scan.schemaVersion, 1);
  assert.equal(scan.runtime, '0.2.2-rc.1');
  const byName = Object.fromEntries(scan.plugins.map((plugin) => [plugin.name, plugin]));
  assert.equal(byName.alpha.verdict, 'will-reject');
  assert.equal(byName['@scope/beta'].verdict, 'will-reject');
  assert.equal(byName.gamma.verdict, 'will-load');
  assert.equal(byName.delta.verdict, 'no-constraint');
  assert.match(byName.alpha.allowCommand, /dsh plugin --profile dsh-profile-scan-.+ allow-version alpha@1\.0\.0 --dsh-version 0\.2\.2-rc\.1 --accept-risk/);
  assert.deepEqual(scan.summary, { total: 4, willReject: 2, willLoad: 1, noConstraint: 1, unknown: 0, firstParty: 0 });
  const text = formatProfileScan(scan);
  assert.match(text, /alpha@1\.0\.0 {2}will-reject/);
  assert.match(text, /grant an exact exemption/);
});

test('scanProfile honours a dsh-version override and falls back to node_modules', (t) => {
  const root = profile(t);
  write(root, 'package.json', { name: 'profile' });
  const fallback = scanProfile(root, { dshVersion: '0.2.0' });
  assert.equal(fallback.plugins.length, 5, 'node_modules fallback includes the DSH packages');
  assert.equal(fallback.plugins.find((plugin) => plugin.name === 'gamma').verdict, 'will-load');
  assert.equal(fallback.plugins.find((plugin) => plugin.name === 'alpha').verdict, 'will-reject');
  assert.throws(() => scanProfile(join(root, 'absent')), /not a profile directory/);
});

test('--profile emits text or JSON and gates will-reject with --exit-code', (t) => {
  const root = profile(t);
  const json = spawnSync(process.execPath, [BIN, '--profile', root, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(json.status, 0);
  const scan = JSON.parse(json.stdout);
  assert.equal(scan.mode, 'profile-scan');
  assert.equal(scan.summary.willReject, 2);
  const gated = spawnSync(process.execPath, [BIN, '--profile', root, '--exit-code'], { cwd: root, encoding: 'utf8' });
  assert.equal(gated.status, 1);
  const text = spawnSync(process.execPath, [BIN, '--profile', root], { cwd: root, encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /will-reject/);
  const unsupported = spawnSync(process.execPath, [BIN, '--profile', root, '--format', 'github'], { cwd: root, encoding: 'utf8' });
  assert.equal(unsupported.status, 2);
});