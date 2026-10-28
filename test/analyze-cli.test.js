/**
 * Contract tests for bin/dsh-plugin-analyze.mjs.
 *
 * The CLI is the public surface, so every test spawns it instead of importing
 * the modules. Fixtures are throwaway packages under the OS temp directory:
 * nothing here reads the real profile, the repo's matrix data, or the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/dsh-plugin-analyze.mjs', import.meta.url));

/** Run the CLI and capture both streams; exit codes are part of the contract. */
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

function tempRoot(t, prefix = 'dsh-analyze-cli-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Create a minimal package directory with a package.json and extra files. */
function packageAt(root, name, { manifest = {}, files = {} } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    main: 'index.js',
    ...manifest,
  }, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    writeFile(join(dir, rel), content);
  }
  return dir;
}

const cleanPackage = (root, name = 'clean-plugin') => packageAt(root, name, {
  files: { 'index.js': 'export const answer = 42;\n' },
});

const riskyPackage = (root, name = 'risky-plugin') => packageAt(root, name, {
  files: { 'index.js': 'export function run(code) {\n  return eval(code);\n}\n' },
});

const brokenLintPackage = (root, name = 'broken-plugin') => packageAt(root, name, {
  manifest: { main: 'missing.js' },
});

const slotPackage = (root, name) => packageAt(root, name, {
  files: {
    'index.js': "ctx.slots.register({ name: 'sidebar' });\nconst legacy = { slot: 'sidebar' };\n",
  },
});

test('--help prints usage to stdout and exits 0', async () => {
  const { code, stdout, stderr } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage/);
  assert.match(stdout, /--json/);
  assert.match(stdout, /--exit-code/);
  assert.match(stdout, /Exit codes/);
  assert.equal(stderr, '');
});

test('-h behaves like --help', async () => {
  const { code, stdout } = await run(['-h']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage/);
});

test('an unknown option exits 2 without writing a report to stdout', async () => {
  const { code, stdout, stderr } = await run(['performance', 'panel', '--bogus']);
  assert.equal(code, 2);
  assert.equal(stdout.trim(), '');
  assert.match(stderr, /unknown option: --bogus/);
});

test('a missing command or argument exits 2', async () => {
  const noCommand = await run([]);
  assert.equal(noCommand.code, 2);
  assert.match(noCommand.stderr, /missing command/);

  const noDir = await run(['full']);
  assert.equal(noDir.code, 2);

  const oneConflictDir = await run(['conflicts', '.']);
  assert.equal(oneConflictDir.code, 2);
});

test('an unknown command exits 2', async () => {
  const { code, stderr } = await run(['nope', 'panel']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command: nope/);
});

test('a directory without package.json exits 2', async (t) => {
  const root = tempRoot(t);
  const { code, stdout, stderr } = await run(['performance', join(root, 'not-a-package')]);
  assert.equal(code, 2);
  assert.equal(stdout.trim(), '');
  assert.match(stderr, /no package.json/);
});

test('conflicts --json prints only JSON and reports the clash', async (t) => {
  const root = tempRoot(t);
  const a = slotPackage(root, 'plugin-a');
  const b = slotPackage(root, 'plugin-b');

  const { code, stdout, stderr } = await run(['conflicts', a, b, '--json']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.ok(stdout.trimStart().startsWith('{'), 'stdout must start with the JSON object');
  const report = JSON.parse(stdout);
  assert.deepEqual(report.targets.map((target) => target.name), ['plugin-a', 'plugin-b']);
  assert.equal(report.summary.total, 1);
  assert.equal(report.slots.length, 1);
});

test('conflicts --exit-code gates on summary.total only when asked', async (t) => {
  const root = tempRoot(t);
  const a = slotPackage(root, 'plugin-a');
  const b = slotPackage(root, 'plugin-b');
  const cleanA = cleanPackage(root, 'clean-a');
  const cleanB = cleanPackage(root, 'clean-b');

  const gated = await run(['conflicts', a, b, '--json', '--exit-code']);
  assert.equal(gated.code, 1);
  assert.equal(JSON.parse(gated.stdout).summary.total, 1);

  const ungated = await run(['conflicts', a, b, '--json']);
  assert.equal(ungated.code, 0, 'without --exit-code a completed run exits 0');

  const gatedClean = await run(['conflicts', cleanA, cleanB, '--json', '--exit-code']);
  assert.equal(gatedClean.code, 0);
  assert.equal(JSON.parse(gatedClean.stdout).summary.total, 0);
});

test('performance --json prints only JSON and --exit-code never gates', async (t) => {
  const root = tempRoot(t);
  const dir = riskyPackage(root);

  const { code, stdout } = await run(['performance', dir, '--json', '--exit-code']);
  assert.equal(code, 0, 'performance analysis has no gate');
  const report = JSON.parse(stdout);
  assert.equal(report.target.name, 'risky-plugin');
  assert.equal(typeof report.score, 'number');
  assert.ok(Array.isArray(report.recommendations));
});

test('security --json reports findings and --exit-code gates on them', async (t) => {
  const root = tempRoot(t);
  const clean = cleanPackage(root);
  const risky = riskyPackage(root);

  const cleanRun = await run(['security', clean, '--json', '--exit-code']);
  assert.equal(cleanRun.code, 0);
  const cleanReport = JSON.parse(cleanRun.stdout);
  assert.deepEqual(cleanReport.findings, []);

  const riskyRun = await run(['security', risky, '--json', '--exit-code']);
  assert.equal(riskyRun.code, 1);
  const riskyReport = JSON.parse(riskyRun.stdout);
  assert.ok(riskyReport.findings.length > 0);
  assert.ok(riskyReport.findings.some((finding) => finding.rule === 'S3'));

  const ungated = await run(['security', risky, '--json']);
  assert.equal(ungated.code, 0, 'without --exit-code findings do not fail the run');
});

test('full --json combines v2 experiments with a nested lint v1 report', async (t) => {
  const root = tempRoot(t);
  const dir = cleanPackage(root);

  const { code, stdout } = await run(['full', dir, '--json', '--exit-code']);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report).sort(), ['experimental', 'lint', 'performance', 'schemaVersion', 'security', 'target']);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.lint.schemaVersion, 1);
  assert.equal(report.performance.schemaVersion, 2);
  assert.equal(report.security.schemaVersion, 2);
  assert.equal(report.experimental, true);
  assert.equal(report.target.name, 'clean-plugin');
  assert.equal(report.lint.summary.error, 0);
  assert.equal(typeof report.performance.score, 'number');
  assert.deepEqual(report.security.findings, []);
});

test('the root entry keeps only the ten stable core exports', async () => {
  const api = await import('../src/index.js');
  assert.deepEqual(Object.keys(api).sort(), [
    'DOC',
    'EVENT_TYPES',
    'RULES',
    'filesCover',
    'formatText',
    'lintPackage',
    'loadPackage',
    'maskSource',
    'toBadge',
    'toSarif',
  ]);
});

test('full --exit-code gates on a lint error or a security finding', async (t) => {
  const root = tempRoot(t);
  const broken = brokenLintPackage(root);
  const risky = riskyPackage(root);

  const lintFailure = await run(['full', broken, '--json', '--exit-code']);
  assert.equal(lintFailure.code, 1);
  assert.ok(JSON.parse(lintFailure.stdout).lint.summary.error > 0);

  const securityFailure = await run(['full', risky, '--json', '--exit-code']);
  assert.equal(securityFailure.code, 1);
  assert.ok(JSON.parse(securityFailure.stdout).security.findings.length > 0);
});
