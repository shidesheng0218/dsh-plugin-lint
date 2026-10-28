/**
 * Contract tests for bin/dsh-plugin-upgrade-plan.mjs.
 *
 * Every test builds its own matrix cells and profile under the OS temp
 * directory and spawns the CLI with that directory as cwd. Nothing reads the
 * repository's matrix snapshot, the real ~/.dsh profiles, the npm cache, or the
 * network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCompatibilityDeclaration } from '../src/upgrade/compatibility.js';

const CLI = fileURLToPath(new URL('../bin/dsh-plugin-upgrade-plan.mjs', import.meta.url));
const FROM = '0.2.0-rc.2';
const TO = '0.3.0';

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...(options.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function tempRoot(t, prefix = 'dsh-upgrade-plan-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * One matrix cell: matrix/cells/<dir>/<dsh>[+web].json, shaped like the probe
 * writes it. The directory is per plugin version, so a test can hold two tested
 * versions of the same plugin (the loader keys cells by name@version, not by the
 * directory name).
 */
function writeCell(root, { name, version, dshVersion = TO, status = 'active', composition = 'headless' }) {
  const dirName = (name + '@' + version).replace(/[^a-zA-Z0-9._@-]/g, '_');
  const file = join(root, 'matrix', 'cells', dirName, dshVersion + (composition === 'web' ? '+web' : '') + '.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    plugin: { name, version },
    dsh: { version: dshVersion, source: 'npm', profile: composition },
    result: { status, composition },
  }, null, 2));
}

function writeProfile(root, { bundles, packages = [], dependencies, extra = {} } = {}) {
  const profile = join(root, 'profile');
  mkdirSync(profile, { recursive: true });
  const manifest = { name: 'dsh-profile-test', ...extra };
  if (bundles !== undefined) manifest.dsh = { profile: { bundles } };
  if (dependencies !== undefined) manifest.dependencies = dependencies;
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const pkg of packages) {
    const pkgPath = join(profile, 'node_modules', ...pkg.name.split('/'));
    mkdirSync(pkgPath, { recursive: true });
    writeFileSync(join(pkgPath, 'package.json'), JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.manifest || { dsh: {} }),
    }, null, 2));
  }
  return profile;
}

function analysisArgs(profile, extra = []) {
  return ['--from', FROM, '--to', TO, '--installed', profile, '--json', ...extra];
}

test('--help prints usage to stdout and exits 0', async () => {
  const { code, stdout, stderr } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage/);
  assert.match(stdout, /--matrix/);
  assert.match(stdout, /--json/);
  assert.match(stdout, /Exit codes/);
  assert.equal(stderr, '');
});

test('an unknown option exits 2', async () => {
  const { code, stderr } = await run(['--bogus-flag']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown option: --bogus-flag/);
});

test('missing arguments exit 2', async () => {
  const empty = await run([]);
  assert.equal(empty.code, 2);

  const missingProfile = await run(['--from', FROM, '--to', TO]);
  assert.equal(missingProfile.code, 2);
  assert.match(missingProfile.stderr, /--installed/);

  const missingTarget = await run(['--check-compatibility', 'panel']);
  assert.equal(missingTarget.code, 2);
  assert.match(missingTarget.stderr, /--target/);
});

test('a missing matrix directory exits 2 instead of guessing', async (t) => {
  const root = tempRoot(t);
  const profile = writeProfile(root, { bundles: ['known-plugin'], packages: [{ name: 'known-plugin', version: '1.0.0' }] });

  const { code, stdout, stderr } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 2);
  assert.equal(stdout.trim(), '', 'no JSON is printed when the run fails');
  assert.match(stderr, /matrix directory not found/);
});

test('an explicit --matrix directory that does not exist exits 2', async (t) => {
  const root = tempRoot(t);
  const profile = writeProfile(root, { bundles: [] });
  const { code, stderr } = await run([...analysisArgs(profile), '--matrix', join(root, 'nope')], { cwd: root });
  assert.equal(code, 2);
  assert.match(stderr, /matrix directory not found/);
});

test('an empty matrix (no cells) exits 2', async (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, 'matrix', 'cells'), { recursive: true });
  const profile = writeProfile(root, { bundles: [] });
  const { code, stderr } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 2);
  assert.match(stderr, /no matrix cells found/);
});

test('--json analysis joins dsh.profile.bundles with matrix cells', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'known-plugin', version: '1.0.0', dshVersion: TO, status: 'active' });
  writeCell(root, { name: 'known-plugin', version: '1.0.0', dshVersion: FROM, status: 'active' });
  const profile = writeProfile(root, {
    bundles: ['known-plugin'],
    packages: [{ name: 'known-plugin', version: '1.0.0' }],
  });

  const { code, stdout, stderr } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'upgrade-plan');
  assert.equal(report.profile.source, 'dsh.profile.bundles');
  assert.equal(report.matrix.cells, 2);
  assert.deepEqual(report.matrix.dshVersions, [FROM, TO]);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.compatible, 1);
  assert.equal(report.categories.compatible[0].name, 'known-plugin');
  assert.equal(report.summary.needAction, 0);
});

test('a plugin the matrix does not cover is unknown, not compatible', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'known-plugin', version: '1.0.0', status: 'active' });
  const profile = writeProfile(root, {
    bundles: ['mystery-plugin'],
    packages: [{ name: 'mystery-plugin', version: '9.9.9' }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0, 'an uncovered plugin is not an action item');
  const report = JSON.parse(stdout);
  assert.equal(report.summary.unknown, 1);
  assert.match(report.categories.unknown[0].reason, /not covered by the matrix/);
});

test('a version the matrix did not test is unknown, with the tested versions named', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'drifting-plugin', version: '1.5.0', status: 'active' });
  const profile = writeProfile(root, {
    bundles: ['drifting-plugin'],
    packages: [{ name: 'drifting-plugin', version: '1.0.0' }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.summary.compatible, 0, 'an untested installed version is not called compatible');
  assert.match(report.categories.unknown[0].reason, /1\.5\.0/);
  assert.deepEqual(report.categories.unknown[0].testedVersions, ['1.5.0']);
});

test('a rejected plugin with another active tested version needs an update (exit 1)', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'stale-plugin', version: '1.0.0', status: 'rejected-by-host' });
  writeCell(root, { name: 'stale-plugin', version: '1.2.0', status: 'active' });
  const profile = writeProfile(root, {
    bundles: ['stale-plugin'],
    packages: [{ name: 'stale-plugin', version: '1.0.0' }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.summary.needsUpdate, 1);
  assert.equal(report.summary.needAction, 1);
  assert.equal(report.categories.needsUpdate[0].recommendedVersion, '1.2.0');
  assert.equal(report.installCommand, 'npm install stale-plugin@1.2.0');
});

test('a rejected plugin with no compatible tested version exits 1', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'dead-plugin', version: '1.0.0', status: 'rejected-by-host' });
  const profile = writeProfile(root, {
    bundles: ['dead-plugin'],
    packages: [{ name: 'dead-plugin', version: '1.0.0' }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.summary.noCompatibleVersion, 1);
  assert.equal(report.categories.noCompatibleVersion[0].status, 'rejected-by-host');
});

test('awaiting-service is reported as untested, not as a failure', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'waiter-plugin', version: '1.0.0', status: 'awaiting-service' });
  const profile = writeProfile(root, {
    bundles: ['waiter-plugin'],
    packages: [{ name: 'waiter-plugin', version: '1.0.0' }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.categories.untested.length, 1);
  assert.equal(report.summary.needAction, 0);
});

test('first-party bundles are counted and flagged, but the matrix does not cover them', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'known-plugin', version: '1.0.0', status: 'active' });
  const profile = writeProfile(root, { bundles: ['@deepseek-ai/dsh-base'] });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.firstParty, 1);
  assert.equal(report.summary.community, 0);
  assert.equal(report.categories.firstParty[0].name, '@deepseek-ai/dsh-base');
  assert.match(report.categories.firstParty[0].reason, /matrix does not cover/);
});

test('bundle entries may be objects, and may omit the version', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'object-plugin', version: '2.0.0', status: 'active' });
  const profile = writeProfile(root, {
    bundles: [{ name: 'object-plugin' }],
    packages: [{ name: 'object-plugin', version: '2.0.0' }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.categories.compatible.length, 1);
  assert.equal(report.categories.compatible[0].version, '2.0.0');
});

test('without dsh.profile.bundles the reader falls back to node_modules', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'scanned-plugin', version: '3.0.0', status: 'active' });
  const profile = writeProfile(root, {
    packages: [{ name: 'scanned-plugin', version: '3.0.0', manifest: { dsh: {} } }],
  });

  const { code, stdout } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.profile.source, 'node_modules');
  assert.equal(report.categories.compatible[0].name, 'scanned-plugin');
});

test('a target DSH version the matrix does not know exits 2', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'known-plugin', version: '1.0.0', dshVersion: FROM, status: 'active' });
  const profile = writeProfile(root, { bundles: ['known-plugin'], packages: [{ name: 'known-plugin', version: '1.0.0' }] });

  const { code, stderr } = await run(analysisArgs(profile), { cwd: root });
  assert.equal(code, 2);
  assert.match(stderr, /no cells for DSH 0\.3\.0/);
});

test('a missing profile directory exits 2', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'known-plugin', version: '1.0.0', status: 'active' });
  const { code, stderr } = await run(
    ['--from', FROM, '--to', TO, '--installed', join(root, 'no-profile'), '--json'],
    { cwd: root },
  );
  assert.equal(code, 2);
  assert.match(stderr, /profile directory not found/);
});

test('human-readable analysis keeps the report structure and the exit code', async (t) => {
  const root = tempRoot(t);
  writeCell(root, { name: 'known-plugin', version: '1.0.0', status: 'active' });
  const profile = writeProfile(root, { bundles: ['known-plugin'], packages: [{ name: 'known-plugin', version: '1.0.0' }] });

  const { code, stdout } = await run(
    ['--from', FROM, '--to', TO, '--installed', profile],
    { cwd: root },
  );
  assert.equal(code, 0);
  assert.match(stdout, /UPGRADE COMPATIBILITY REPORT/);
  assert.match(stdout, /known-plugin@1\.0\.0/);
  assert.match(stdout, /Summary:/);
});

function writeCheckPlugin(root, declared) {
  const dir = join(root, 'checked-plugin');
  mkdirSync(dir, { recursive: true });
  const manifest = { name: 'checked-plugin', version: '1.0.0', main: 'index.js' };
  if (declared !== undefined) manifest.dsh = { compatibility: { dshReleases: declared } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.js'), 'export const answer = 42;\n');
  return dir;
}

test('--check-compatibility exits 0 for a declared compatible version', async (t) => {
  const root = tempRoot(t);
  const dir = writeCheckPlugin(root, { [TO]: 'compatible' });

  // No matrix/cells in cwd: check mode reads the plugin declaration, not the matrix.
  const { code, stdout } = await run(['--check-compatibility', dir, '--target', TO, '--json'], { cwd: root });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'check-compatibility');
  assert.equal(report.status, 'compatible');
  assert.equal(report.dshVersion, TO);
});

test('--check-compatibility exits 1 for a declared incompatible version', async (t) => {
  const root = tempRoot(t);
  const dir = writeCheckPlugin(root, { [TO]: 'incompatible' });

  const { code, stdout } = await run(['--check-compatibility', dir, '--target', TO, '--json'], { cwd: root });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).status, 'incompatible');
});

test('--check-compatibility exits 2 when the target is not declared', async (t) => {
  const root = tempRoot(t);
  const dir = writeCheckPlugin(root, { [FROM]: 'compatible' });

  const { code, stdout } = await run(['--check-compatibility', dir, '--target', TO, '--json'], { cwd: root });
  assert.equal(code, 2);
  const report = JSON.parse(stdout);
  assert.equal(report.status, 'unknown');
  assert.match(report.reason, new RegExp(TO.replace(/\./g, '\\.')));
});

test('--check-compatibility exits 2 when nothing is declared', async (t) => {
  const root = tempRoot(t);
  const dir = writeCheckPlugin(root, undefined);

  const { code, stdout } = await run(['--check-compatibility', dir, '--target', TO, '--json'], { cwd: root });
  assert.equal(code, 2);
  const report = JSON.parse(stdout);
  assert.equal(report.status, 'unknown');
  assert.match(report.reason, /does not declare/);
});

test('--matrix accepts an arbitrary cells directory instead of ./matrix/cells', async (t) => {
  const root = tempRoot(t);
  const matrixRoot = join(root, 'snapshot');
  writeCell(matrixRoot, { name: 'custom-plugin', version: '1.0.0', status: 'active' });
  const cellsDir = join(matrixRoot, 'matrix', 'cells');
  const profile = writeProfile(root, {
    bundles: ['custom-plugin'],
    packages: [{ name: 'custom-plugin', version: '1.0.0' }],
  });

  const { code, stdout } = await run(
    ['--from', FROM, '--to', TO, '--installed', profile, '--matrix', cellsDir, '--json'],
    { cwd: root },
  );
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.matrix.dir, cellsDir);
  assert.equal(report.categories.compatible.length, 1);
});

test('compatibility declarations distinguish explicit values from unknown ones', () => {
  assert.equal(classifyCompatibilityDeclaration('compatible'), 'compatible');
  assert.equal(classifyCompatibilityDeclaration(true), 'compatible');
  assert.equal(classifyCompatibilityDeclaration({ compatible: true }), 'compatible');
  assert.equal(classifyCompatibilityDeclaration('incompatible'), 'incompatible');
  assert.equal(classifyCompatibilityDeclaration(false), 'incompatible');
  assert.equal(classifyCompatibilityDeclaration({ compatible: false }), 'incompatible');
  assert.equal(classifyCompatibilityDeclaration({ status: 'unsupported' }), 'incompatible');
  assert.equal(classifyCompatibilityDeclaration('pending'), 'unknown');
  assert.equal(classifyCompatibilityDeclaration({ status: 'pending' }), 'unknown');
  assert.equal(classifyCompatibilityDeclaration({ status: 'compatible' }), 'unknown');
  assert.equal(classifyCompatibilityDeclaration(undefined), 'unknown');
});

test('--check-compatibility treats pending as unknown and exits 2', async (t) => {
  const root = tempRoot(t);
  const dir = writeCheckPlugin(root, { [TO]: 'pending' });
  const { code, stdout } = await run(['--check-compatibility', dir, '--target', TO, '--json'], { cwd: root });
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).status, 'unknown');
});
