import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readProfile } from '../src/upgrade/profile.js';

function dir(t, prefix = 'dsh-profile-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

test('readProfile rejects a missing or non-directory path', (t) => {
  const root = dir(t);
  assert.throws(() => readProfile(join(root, 'absent')), /profile directory not found/);
  write(root, 'file', 'x');
  assert.throws(() => readProfile(join(root, 'file')), /profile directory not found/);
});

test('readProfile reads dsh.profile.bundles and resolves versions from every supported shape', (t) => {
  const root = dir(t);
  write(root, 'package.json', {
    name: 'profile',
    dependencies: { theta: '3.0.0', eta: '^9.9.9' },
    dsh: { profile: { bundles: [
      'alpha',
      { name: 'beta', version: '1.2.3' },
      { id: 'gamma' },
      { package: 'delta' },
      { bundle: 'epsilon' },
      { plugin: 'zeta' },
      { name: 'alpha' },
      { name: '' },
      { name: 'eta' },
      { name: 'theta' },
      { name: '@deepseek-ai/first-party', version: '4.0.0' },
    ] } },
  });
  write(root, 'node_modules/eta/package.json', { name: 'eta', version: '2.0.0' });
  const profile = readProfile(root);
  assert.equal(profile.source, 'dsh.profile.bundles');
  const byName = Object.fromEntries(profile.plugins.map((plugin) => [plugin.name, plugin]));
  assert.deepEqual(Object.keys(byName).sort(), ['@deepseek-ai/first-party', 'alpha', 'beta', 'delta', 'epsilon', 'eta', 'gamma', 'theta', 'zeta']);
  assert.equal(byName.beta.version, '1.2.3');
  assert.equal(byName.eta.version, '2.0.0', 'installed manifest wins over the dependency range');
  assert.equal(byName.theta.version, '3.0.0');
  assert.equal(byName['@deepseek-ai/first-party'].firstParty, true);
  assert.equal(byName.alpha.firstParty, false);
});

test('readProfile accepts only a known composition', (t) => {
  const root = dir(t);
  write(root, 'package.json', { dsh: { profile: { composition: 'web', bundles: ['alpha'] } } });
  assert.equal(readProfile(root).composition, 'web');
  write(root, 'package.json', { dsh: { profile: { composition: 'tui', bundles: ['alpha'] } } });
  assert.equal(readProfile(root).composition, undefined);
});

test('readProfile falls back to a node_modules scan and skips non-plugins and broken manifests', (t) => {
  const root = dir(t);
  write(root, 'package.json', { name: 'profile' });
  write(root, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', dsh: {} });
  write(root, 'node_modules/@scope/beta/package.json', { name: '@scope/beta', version: '2.0.0', keywords: ['dsh-plugin'] });
  write(root, 'node_modules/plain/package.json', { name: 'plain', version: '3.0.0' });
  write(root, 'node_modules/broken/package.json', '{not json');
  write(root, 'node_modules/no-name/package.json', { version: '4.0.0', dsh: {} });
  write(root, 'node_modules/.hidden/package.json', { name: 'hidden', version: '5.0.0', dsh: {} });
  const profile = readProfile(root);
  assert.equal(profile.source, 'node_modules');
  const names = profile.plugins.map((plugin) => plugin.name).sort();
  assert.deepEqual(names, ['@scope/beta', 'alpha', 'no-name']);
  assert.equal(profile.plugins.find((plugin) => plugin.name === 'no-name').version, '4.0.0');
});

test('readProfile handles an empty node_modules and a profile without package.json', (t) => {
  const empty = dir(t);
  write(empty, 'package.json', { name: 'profile' });
  mkdirSync(join(empty, 'node_modules'), { recursive: true });
  const emptyProfile = readProfile(empty);
  assert.deepEqual(emptyProfile.plugins, []);
  assert.equal(emptyProfile.source, 'node_modules');

  const noManifest = dir(t);
  mkdirSync(join(noManifest, 'node_modules/alpha'), { recursive: true });
  write(noManifest, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', dsh: {} });
  assert.equal(readProfile(noManifest).source, 'node_modules');

  const neither = dir(t);
  assert.throws(() => readProfile(neither), /not a profile directory/);
});