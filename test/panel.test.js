import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const panel = await import(fileURLToPath(new URL('../panel/index.js', import.meta.url)));
const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL('../panel/data/matrix-index.json', import.meta.url)), 'utf8'));

/** A profile directory shaped like the real one: selected bundles plus what is installed. */
function profile(installed) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-'));
  // The manifest lists bundle NAMES; the version lives in what is installed.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    dsh: { profile: { bundles: installed.map((entry) => entry.name) } },
  }));
  for (const entry of installed) {
    mkdirSync(join(dir, 'node_modules', entry.name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', entry.name, 'package.json'), JSON.stringify({ name: entry.name, version: entry.version }));
  }
  return dir;
}

const withProfile = (dir, fn) => {
  const before = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = dir;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the panel reports the installed version of every selected bundle', () => {
  const covered = snapshot.plugins[0].name;
  const dir = profile([{ name: covered, version: '9.9.9' }, { name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2' }]);
  withProfile(dir, () => {
    const data = panel.payload();
    assert.equal(data.ok, true);
    assert.equal(data.rows.length, 2);
    const row = data.rows.find((r) => r.name === covered);
    assert.equal(row.version, '9.9.9', 'the installed version wins over the bundle spec');
    assert.equal(row.known, true, 'a plugin in the snapshot is marked as covered');
    assert.ok(row.cells.length >= 1);
    assert.ok(row.cells.every((c) => typeof c.status === 'string'));
    const firstParty = data.rows.find((r) => r.name === '@deepseek-ai/dsh-base');
    assert.equal(firstParty.firstParty, true);
  });
});

test('the panel marks a bundle the matrix does not cover', () => {
  const dir = profile([{ name: 'a-plugin-nobody-has-heard-of', version: '0.0.1' }]);
  withProfile(dir, () => {
    const row = panel.payload().rows[0];
    assert.equal(row.known, false);
    assert.deepEqual(row.cells, []);
  });
});

test('the panel explains itself when the profile cannot be read', () => {
  const before = process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE_DIR;
  try {
    const data = panel.payload();
    assert.equal(data.ok, true, 'a missing profile is not an error');
    assert.match(data.profile.error, /DSH_PROFILE_DIR/);
    assert.deepEqual(data.rows, []);
  } finally {
    if (before !== undefined) process.env.DSH_PROFILE_DIR = before;
  }
});

test('the panel exposes the running DSH version when it can resolve it', () => {
  const data = panel.payload();
  assert.ok(data.dsh.version === undefined || /^\d+\.\d+\.\d+/.test(data.dsh.version));
});

test('the route path is stable', () => {
  assert.equal(panel.ROUTE, '/api/dsh-plugin-lint/panel');
});
