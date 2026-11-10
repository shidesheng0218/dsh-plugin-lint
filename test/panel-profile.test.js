import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  currentVersion,
  installedBundles,
  profileDir,
  profileSnapshot,
  runningDshVersion,
  runningProfileName,
} from '../panel/host/profile.js';

function dir(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('currentVersion reads the shipped panel manifest', () => {
  assert.equal(currentVersion(), '0.2.0');
});

test('runningProfileName defaults to desktop and honours an explicit profile', () => {
  assert.equal(runningProfileName(['node', 'cli']), 'desktop');
  assert.equal(runningProfileName(['node', 'cli', '--profile', 'work']), 'work');
  assert.equal(runningProfileName(['node', 'cli', '--profile', '--flag']), 'desktop');
});

test('profileDir follows the explicit environment variables', (t) => {
  const root = dir(t);
  assert.equal(withEnv({ DSH_PROFILE_DIR: root, DSH_HOME: undefined }, () => profileDir()), root);

  write(root, 'profiles/work/package.json', { name: 'p' });
  const originalArgv = process.argv;
  process.argv = [...originalArgv, '--profile', 'work'];
  try {
    assert.equal(withEnv({ DSH_PROFILE_DIR: undefined, DSH_HOME: root }, () => profileDir()), join(root, 'profiles', 'work'));
    process.argv = [...originalArgv, '--profile', 'absent'];
    assert.equal(withEnv({ DSH_PROFILE_DIR: undefined, DSH_HOME: root }, () => profileDir()), undefined);
    assert.equal(withEnv({ DSH_PROFILE_DIR: undefined, DSH_HOME: undefined }, () => profileDir()), undefined);
  } finally {
    process.argv = originalArgv;
  }
});

test('installedBundles reports missing configuration, unreadable manifests and bundle provenance', (t) => {
  const root = dir(t);
  assert.match(withEnv({ DSH_PROFILE_DIR: undefined, DSH_HOME: undefined }, () => installedBundles()).error, /not set/);

  write(root, 'package.json', '{broken');
  assert.match(withEnv({ DSH_PROFILE_DIR: root }, () => installedBundles()).error, /no package.json/);

  write(root, 'package.json', { dsh: { profile: { bundles: ['alpha', '', 42, '@deepseek-ai/core', 'ghost'] } } });
  write(root, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.2.3' });
  const installed = withEnv({ DSH_PROFILE_DIR: root }, () => installedBundles());
  assert.equal(installed.dir, root);
  assert.deepEqual(installed.bundles, [
    { name: 'alpha', version: '1.2.3', providedBy: 'profile' },
    { name: '@deepseek-ai/core', version: undefined, providedBy: 'dsh-installation' },
    { name: 'ghost', version: undefined, providedBy: undefined },
  ]);
});

test('profileSnapshot keeps only a known composition', (t) => {
  const root = dir(t);
  write(root, 'package.json', { dsh: { profile: { bundles: ['alpha'], composition: 'web' } } });
  const web = withEnv({ DSH_PROFILE_DIR: root }, () => profileSnapshot());
  assert.equal(web.dir, root);
  assert.equal(web.composition, 'web');
  assert.equal(web.bundles.length, 1);
  write(root, 'package.json', { dsh: { profile: { bundles: ['alpha'], composition: 'tui' } } });
  assert.equal(withEnv({ DSH_PROFILE_DIR: root }, () => profileSnapshot()).composition, undefined);
});

test('runningDshVersion can read the harness beside the current entry point', (t) => {
  const root = dir(t);
  const bin = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  write(root, join('@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-test' });
  const originalArgv = process.argv;
  process.argv = [originalArgv[0], bin];
  try {
    assert.equal(runningDshVersion(), '0.2.1-test');
  } finally {
    process.argv = originalArgv;
  }
});