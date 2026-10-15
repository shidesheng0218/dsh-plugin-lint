import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/upgrade-preview.mjs', import.meta.url));

/**
 * Build a throwaway profile and index on disk, run the preview, return stdout.
 * The script is the public surface, so the tests go through it end to end.
 */
function run(profileBundles, index, args = []) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-upgrade-preview-'));
  const profileDir = join(home, 'profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    dsh: { profile: { bundles: profileBundles } },
  }));
  const indexPath = join(home, 'index.json');
  writeFileSync(indexPath, JSON.stringify(index));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, profileDir, '--index', indexPath, ...args], { encoding: 'utf8' });
    return { out, code: 0 };
  } catch (error) {
    return { out: String(error.stdout || '') + String(error.stderr || ''), code: error.status ?? 1 };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const INDEX = {
  schemaVersion: 1,
  generatedAt: '2026-10-13T00:00:00.000Z',
  dshVersions: ['0.2.0-rc.2', '0.2.1-alpha.2'],
  plugins: [
    {
      name: 'stays-active',
      version: '1.0.0',
      cells: [
        { dsh: '0.2.0-rc.2', composition: 'headless', status: 'active', trust: 'verified', toolsAdded: ['a'] },
        { dsh: '0.2.1-alpha.2', composition: 'headless', status: 'active', trust: 'verified', toolsAdded: ['a'] },
      ],
    },
    {
      name: 'gets-rejected',
      version: '1.0.0',
      cells: [
        { dsh: '0.2.0-rc.2', composition: 'headless', status: 'active', trust: 'verified', toolsAdded: [] },
        { dsh: '0.2.1-alpha.2', composition: 'headless', status: 'rejected-by-host', trust: 'verified', toolsAdded: [] },
      ],
    },
    {
      // One favourable composition must win over an unfavourable one on the
      // same version — the site generator's ranking, applied to the preview.
      name: 'waits-in-headless',
      version: '1.0.0',
      cells: [
        { dsh: '0.2.0-rc.2', composition: 'headless', status: 'awaiting-service', trust: 'verified', toolsAdded: [] },
        { dsh: '0.2.0-rc.2', composition: 'web', status: 'active', trust: 'verified', toolsAdded: [] },
        { dsh: '0.2.1-alpha.2', composition: 'headless', status: 'awaiting-service', trust: 'verified', toolsAdded: [] },
        { dsh: '0.2.1-alpha.2', composition: 'web', status: 'active', trust: 'verified', toolsAdded: [] },
      ],
    },
  ],
};

test('a plugin that degrades across versions is reported as worse', () => {
  const { out, code } = run(['stays-active', 'gets-rejected'], INDEX);
  assert.equal(code, 0);
  assert.match(out, /1 worse/);
  assert.match(out, /✗ {2}gets-rejected/);
  assert.match(out, /0\.2\.0-rc\.2: active {3}-> {3}0\.2\.1-alpha\.2: rejected-by-host/);
});

test('a plugin with the same verdict on both versions is unchanged', () => {
  const { out } = run(['stays-active'], INDEX);
  assert.match(out, /1 unchanged/);
  assert.match(out, /= {2}stays-active/);
});

test('the most favourable composition wins, so a web-active plugin is not reported as waiting', () => {
  const { out } = run(['waits-in-headless'], INDEX);
  assert.match(out, /1 unchanged/);
  assert.match(out, /0\.2\.1-alpha\.2: active/, 'the web cell wins over the headless awaiting cell');
});

test('a plugin the matrix does not cover is reported as unknown, not as a verdict', () => {
  const { out } = run(['nobody-knows-this'], INDEX);
  assert.match(out, /1 not covered/);
  assert.match(out, /\? {2}nobody-knows-this/);
  assert.match(out, /no data/);
});

test('first-party bundles are counted but not previewed', () => {
  const { out } = run(['stays-active', '@deepseek-ai/dsh-base'], INDEX);
  assert.match(out, /2 installed \(1 community, 1 first-party\)/);
  assert.doesNotMatch(out, /@deepseek-ai\/dsh-base\n/);
});

test('a target version the index does not know is refused', () => {
  const { out, code } = run(['stays-active'], INDEX, ['--to', '9.9.9']);
  assert.equal(code, 2);
  assert.match(out, /no cells for DSH 9\.9\.9/);
});
