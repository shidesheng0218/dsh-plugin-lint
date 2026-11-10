#!/usr/bin/env node
/**
 * Release smoke test: build the two real tarballs, install them into a clean
 * prefix, and exercise every published surface. Unit tests run against the
 * checkout; this is the only check that catches a file missing from `files`,
 * a bin that cannot resolve its imports, or an entry point that changed shape.
 *
 *   node scripts/package-smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT_NAME = '@shidesheng0218/dsh-plugin-lint';
const PANEL_NAME = '@shidesheng0218/dsh-plugin-lint-panel';

const CORE_EXPORTS = [
  'DOC', 'EVENT_TYPES', 'RULES', 'filesCover', 'formatText',
  'lintPackage', 'loadPackage', 'maskSource', 'toBadge', 'toSarif',
].sort();
const EXPERIMENTAL_EXPORTS = ['SECURITY_LIMITS', 'SECURITY_RULES', 'analyzePerformance', 'analyzeSecurityDeep', 'detectConflicts'];
const BINS = ['dsh-plugin-lint', 'dsh-plugin-probe', 'dsh-plugin-analyze', 'dsh-plugin-upgrade-plan', 'dsh-plugin-matrix'];

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const work = mkdtempSync(join(tmpdir(), 'dsh-package-smoke-'));
try {
  const packs = join(work, 'packs');
  const install = join(work, 'install');
  mkdirSync(packs, { recursive: true });
  mkdirSync(install, { recursive: true });

  const rootTgz = join(packs, run('npm', ['pack', '--silent', '--pack-destination', packs], { cwd: ROOT }).trim());
  const panelTgz = join(packs, run('npm', ['pack', '--silent', '--pack-destination', packs], { cwd: join(ROOT, 'panel') }).trim());

  run('npm', ['init', '-y'], { cwd: install });
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', rootTgz, panelTgz], { cwd: install });

  const core = JSON.parse(run(process.execPath, ['--input-type=module', '-e',
    `const m = await import('${ROOT_NAME}'); process.stdout.write(JSON.stringify(Object.keys(m).sort()));`,
  ], { cwd: install }));
  assert(JSON.stringify(core) === JSON.stringify(CORE_EXPORTS), 'core exports changed: ' + core.join(','));

  const experimental = JSON.parse(run(process.execPath, ['--input-type=module', '-e',
    `const m = await import('${ROOT_NAME}/experimental'); process.stdout.write(JSON.stringify(Object.keys(m).sort()));`,
  ], { cwd: install }));
  for (const name of EXPERIMENTAL_EXPORTS) assert(experimental.includes(name), 'missing experimental export: ' + name);

  run(process.execPath, ['--input-type=module', '-e',
    `const m = await import('${PANEL_NAME}'); if (typeof m.apply !== 'function') process.exit(1);`,
  ], { cwd: install });

  for (const bin of BINS) {
    const target = join(install, 'node_modules', '.bin', bin);
    const out = run(target, ['--help'], { cwd: install });
    assert(out.length > 0, bin + ' --help printed nothing');
  }

  const panelDir = join(install, 'node_modules', PANEL_NAME);
  const lint = run(join(install, 'node_modules', '.bin', 'dsh-plugin-lint'), [panelDir, '--no-color', '--exit-code'], { cwd: install });
  assert(/0 error/.test(lint), 'the installed linter did not report a clean panel');

  console.log('package smoke: PASS (' + rootTgz.split('/').pop() + ', ' + panelTgz.split('/').pop() + ')');
} finally {
  rmSync(work, { recursive: true, force: true });
}