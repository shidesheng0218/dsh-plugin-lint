import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The panel reads a locally generated matrix snapshot, addressed by
 * DSH_PLUGIN_LINT_INDEX, so the tests build their own instead of depending on a
 * data file this repository does not ship.
 */
const FIXTURE_INDEX = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  dshVersions: ['0.2.0-rc.2', '0.2.1-alpha.2'],
  plugins: [
    {
      name: 'covered-plugin',
      version: '1.0.0',
      cells: [
        { dsh: '0.2.0-rc.2', status: 'active', trust: 'verified', at: '2026-01-01T00:00:00.000Z', toolsAdded: ['a_tool'], reproduce: 'probe covered-plugin' },
        { dsh: '0.2.1-alpha.2', status: 'rejected-by-host', trust: 'verified', at: '2026-01-01T00:00:00.000Z', toolsAdded: [], reproduce: 'probe covered-plugin' },
      ],
    },
  ],
};

const indexDir = mkdtempSync(join(tmpdir(), 'dsh-panel-index-'));
const indexPath = join(indexDir, 'matrix-index.json');
writeFileSync(indexPath, JSON.stringify(FIXTURE_INDEX));
process.env.DSH_PLUGIN_LINT_INDEX = indexPath;
const panel = await import(fileURLToPath(new URL('../panel/index.js', import.meta.url)));

/** A profile directory shaped like the real one: selected bundles plus what is installed. */
function profile(installed) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-'));
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
  const dir = profile([{ name: 'covered-plugin', version: '9.9.9' }, { name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2' }]);
  withProfile(dir, () => {
    const data = panel.payload();
    assert.equal(data.ok, true);
    assert.equal(data.rows.length, 2);
    const row = data.rows.find((r) => r.name === 'covered-plugin');
    assert.equal(row.version, '9.9.9', 'the installed version wins over the bundle spec');
    assert.equal(row.known, true, 'a plugin in the snapshot is marked as covered');
    assert.equal(row.cells.length, 2);
    assert.deepEqual(row.cells.map((c) => c.status), ['active', 'rejected-by-host']);
    assert.deepEqual(data.matrix.dshVersions, FIXTURE_INDEX.dshVersions);
    assert.equal(data.rows.find((r) => r.name === '@deepseek-ai/dsh-base').firstParty, true);
  });
});

test('the panel says who provides a bundle, not just whether it was found', () => {
  // A first-party bundle is resolved from the dsh installation, so its absence
  // from the profile's node_modules is normal. The page used to call that "not
  // installed" until providedBy was carried through to the row.
  const dir = profile([{ name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2' }]);
  withProfile(dir, () => {
    const row = panel.payload().rows[0];
    assert.equal(row.firstParty, true);
    assert.equal(row.providedBy, 'profile');
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

test('the panel survives a bundle list holding something that is not a name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [{ oops: true }, 'covered-plugin'] } } }));
  mkdirSync(join(dir, 'node_modules', 'covered-plugin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'covered-plugin', 'package.json'), JSON.stringify({ name: 'covered-plugin', version: '2.0.0' }));
  withProfile(dir, () => {
    const rows = panel.payload().rows;
    assert.equal(rows.length, 1, 'the malformed entry is skipped rather than thrown');
    assert.equal(rows[0].name, 'covered-plugin');
  });
});

test('a missing snapshot leaves every plugin uncovered instead of failing', () => {
  const saved = process.env.DSH_PLUGIN_LINT_INDEX;
  process.env.DSH_PLUGIN_LINT_INDEX = join(indexDir, 'does-not-exist.json');
  try {
    const data = panel.payload();
    assert.equal(data.ok, true);
    assert.deepEqual(data.matrix.dshVersions, []);
    assert.equal(data.matrix.plugins, 0);
  } finally {
    process.env.DSH_PLUGIN_LINT_INDEX = saved;
  }
});

test('a verified cell older than the staleness window is reported as stale', () => {
  const dir = profile([{ name: 'covered-plugin', version: '1.0.0' }]);
  withProfile(dir, () => {
    const row = panel.payload().rows.find((r) => r.name === 'covered-plugin');
    // The fixture cells are dated 2026-01-01, long past the 30-day window.
    assert.deepEqual(row.cells.map((c) => c.trust), ['stale', 'stale']);
  });
});

test('a recent verified cell keeps its trust', () => {
  const saved = process.env.DSH_PLUGIN_LINT_INDEX;
  const fresh = {
    ...FIXTURE_INDEX,
    plugins: [{
      name: 'covered-plugin',
      version: '1.0.0',
      cells: [{ dsh: '0.2.0-rc.2', status: 'active', trust: 'verified', at: new Date().toISOString(), toolsAdded: [], reproduce: '' }],
    }],
  };
  const freshPath = join(indexDir, 'fresh-index.json');
  writeFileSync(freshPath, JSON.stringify(fresh));
  process.env.DSH_PLUGIN_LINT_INDEX = freshPath;
  try {
    const dir = profile([{ name: 'covered-plugin', version: '1.0.0' }]);
    withProfile(dir, () => {
      const row = panel.payload().rows.find((r) => r.name === 'covered-plugin');
      assert.equal(row.cells[0].trust, 'verified');
    });
  } finally {
    process.env.DSH_PLUGIN_LINT_INDEX = saved;
  }
});

test('the route path is stable', () => {
  assert.equal(panel.ROUTE, '/api/dsh-plugin-lint/panel');
});
