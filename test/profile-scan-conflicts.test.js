import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProfile, formatProfileScan } from '../src/core/profile-scan.js';

function makeProfile() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-conflicts-'));
  write(root, 'package.json', JSON.stringify({ name: 'profile', private: true }));
  return root;
}

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// Minimal runtime so scanProfile can resolve a runtime version.
function writeRuntime(root, version = '0.2.2-rc.1') {
  write(root, 'node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version }));
}

// A plugin whose source registers a slot, so detectConflicts has jsFiles to read.
function writePluginWithSlot(root, name, slot, version = '1.0.0') {
  const base = 'node_modules/' + name;
  write(root, base + '/package.json', JSON.stringify({
    name, version, dsh: { plugin: true }, main: 'index.js',
  }));
  write(root, base + '/index.js', `ctx.slots.register({ name: '${slot}' });\n`);
}

// The runtime package itself lands in the profile plugin list; account for it.
const RUNTIME_COUNT = 1;

test('profile conflict scan detects two installed plugins claiming the same slot', () => {
  const root = makeProfile();
  writeRuntime(root);
  writePluginWithSlot(root, 'alpha', 'settings.section');
  writePluginWithSlot(root, 'beta', 'settings.section');
  const scan = scanProfile(root, {});
  assert.equal(scan.mode, 'profile-scan');
  assert.ok(Array.isArray(scan.conflicts?.slots));
  assert.equal(scan.conflicts.slots.length, 1);
  assert.deepEqual(scan.conflicts.slots[0].plugins.sort(), ['alpha', 'beta']);
});

test('existing peer verdict fields are unchanged by the conflicts addition', () => {
  const root = makeProfile();
  writeRuntime(root);
  writePluginWithSlot(root, 'alpha', 'settings.section');
  writePluginWithSlot(root, 'beta', 'settings.section');
  const scan = scanProfile(root, {});
  assert.equal(scan.schemaVersion, 1);
  assert.equal(scan.runtime, '0.2.2-rc.1');
  assert.equal(scan.summary.total, 2 + RUNTIME_COUNT);
  assert.ok(Array.isArray(scan.limits));
});

test('a candidate package is marked, evaluated for peers, and joined into conflicts', () => {
  const root = makeProfile();
  writeRuntime(root);
  writePluginWithSlot(root, 'installed', 'settings.section');
  // candidate lives outside the profile
  const cand = mkdtempSync(join(tmpdir(), 'candidate-'));
  write(cand, 'package.json', JSON.stringify({
    name: 'candidate', version: '1.0.0', dsh: { plugin: true }, main: 'index.js',
    peerDependencies: { '@deepseek-ai/dsh': '>=9.9.9' },
  }));
  write(cand, 'index.js', "ctx.slots.register({ name: 'settings.section' });\n");
  const scan = scanProfile(root, { candidate: cand });
  const candEntry = scan.plugins.find((p) => p.name === 'candidate');
  assert.equal(candEntry.candidate, true);
  assert.equal(candEntry.verdict, 'will-reject');
  assert.equal(scan.summary.willReject, 1);
  // candidate + installed collide on the slot
  const slot = scan.conflicts.slots.find((s) => s.plugins.includes('candidate'));
  assert.ok(slot, 'candidate participates in slot conflicts');
});

test('conflict scan bounds trip and record a limits note, peer verdicts still complete', () => {
  const root = makeProfile();
  writeRuntime(root);
  // Three plugins; force maxPlugins=1 so only one gets conflict-scanned.
  for (const name of ['p1', 'p2', 'p3']) writePluginWithSlot(root, name, 'settings.section');
  const scan = scanProfile(root, { maxPlugins: 1 });
  // all three plus the runtime still get peer verdicts
  assert.equal(scan.summary.total, 3 + RUNTIME_COUNT);
  // bound recorded in limits
  assert.ok(scan.limits.some((l) => /conflict scan/i.test(l) || /skipped/i.test(l)));
});

test('formatProfileScan appends a conflicts section when conflicts exist', () => {
  const root = makeProfile();
  writeRuntime(root);
  writePluginWithSlot(root, 'alpha', 'settings.section');
  writePluginWithSlot(root, 'beta', 'settings.section');
  const scan = scanProfile(root, {});
  const text = formatProfileScan(scan);
  assert.match(text, /conflict/i);
  assert.match(text, /settings\.section/);
});
