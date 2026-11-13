import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarball } from './tarball.js';

export function detectPackageManager(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function run(command, args, cwd) {
  const env = { ...process.env, npm_config_ignore_scripts: 'true', YARN_ENABLE_SCRIPTS: 'false' };
  // Package managers are Node programs; under NODE_V8_COVERAGE they would add
  // their own internals to the caller's coverage report.
  delete env.NODE_V8_COVERAGE;
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function findTarball(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
  if (names.length === 0) throw new Error('the package manager did not produce a .tgz');
  return join(dir, names[0]);
}

/** Pack a local package and return the tarball path plus a cleanup handle. */
export function packDirectory(dir, { manager = 'auto', ignoreScripts = true } = {}) {
  const pm = manager === 'auto' ? detectPackageManager(dir) : manager;
  const out = mkdtempSync(join(tmpdir(), 'dsh-pack-'));
  const flags = ignoreScripts ? ['--ignore-scripts'] : [];
  try {
    if (pm === 'npm') run('npm', ['pack', ...flags, '--pack-destination', out], dir);
    else if (pm === 'pnpm') {
      // pnpm pack has no --ignore-scripts flag; the config form is the supported switch.
      const noScripts = ignoreScripts ? ['--config.ignore-scripts=true'] : [];
      run('pnpm', ['pack', ...noScripts, '--pack-destination', out], dir);
    } else if (pm === 'bun') run('bun', ['pm', 'pack', ...flags, '--destination', out], dir);
    else if (pm === 'yarn') {
      // Yarn Berry disables lifecycle scripts through YARN_ENABLE_SCRIPTS (set in run()).
      const target = join(out, 'package.tgz');
      try {
        run('yarn', ['pack', '--filename', target], dir);
      } catch {
        run('yarn', ['pack', '--out', target], dir);
      }
    } else {
      throw new Error('unknown package manager: ' + pm);
    }
    return { tarball: findTarball(out), manager: pm, cleanup: () => rmSync(out, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw new Error('pack failed with ' + pm + ': ' + String(error.stderr || error.message).trim().slice(0, 400));
  }
}

/** Download a published package with npm pack and return the tarball. */
export function packFromNpm(spec) {
  const out = mkdtempSync(join(tmpdir(), 'dsh-npm-pack-'));
  try {
    run('npm', ['pack', spec, '--ignore-scripts', '--pack-destination', out], process.cwd());
    return { tarball: findTarball(out), source: 'npm:' + spec, cleanup: () => rmSync(out, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw new Error('npm pack ' + spec + ' failed: ' + String(error.stderr || error.message).trim().slice(0, 400));
  }
}

export function findPackageRoot(dir) {
  if (existsSync(join(dir, 'package.json'))) return dir;
  const children = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const child of children) {
    const path = join(dir, child.name);
    if (existsSync(join(path, 'package.json'))) return path;
  }
  throw new Error('the tarball contains no package.json');
}

/** Extract a tarball into a fresh temp directory and return the package root. */
export function extractTarballTo(dir) {
  const out = mkdtempSync(join(tmpdir(), 'dsh-tarball-'));
  try {
    extractTarball(readFileSync(dir), out);
    return { root: findPackageRoot(out), cleanup: () => rmSync(out, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}