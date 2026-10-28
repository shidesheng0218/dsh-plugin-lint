import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export function currentVersion() {
  return readJson(fileURLToPath(new URL('../package.json', import.meta.url)))?.version;
}

export function runningDshVersion() {
  const candidates = [];
  try { candidates.push(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))); } catch { /* not resolvable */ }
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.includes('@deepseek-ai')) {
    const marker = entry.indexOf('@deepseek-ai');
    candidates.push(join(entry.slice(0, marker), '@deepseek-ai', 'dsh', 'package.json'));
  }
  for (const candidate of candidates) {
    const version = readJson(candidate)?.version;
    if (version) return version;
  }
  return undefined;
}

export function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME;
  if (!home) return undefined;
  const argv = process.argv || [];
  const index = argv.indexOf('--profile');
  const name = index >= 0 ? argv[index + 1] : undefined;
  if (!name || name.startsWith('-')) return undefined;
  const dir = join(home, 'profiles', name);
  return existsSync(join(dir, 'package.json')) ? dir : undefined;
}

export function installedBundles() {
  const dir = profileDir();
  if (!dir) return { error: 'DSH_PROFILE_DIR is not set, so the installed plugins cannot be listed' };
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest) return { error: 'no package.json in ' + dir };
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((name) => typeof name === 'string' && name !== '');
  return {
    dir,
    bundles: bundles.map((name) => {
      const version = readJson(join(dir, 'node_modules', name, 'package.json'))?.version;
      const providedBy = version ? 'profile' : (name.startsWith('@deepseek-ai/') ? 'dsh-installation' : undefined);
      return { name, version, providedBy };
    }),
  };
}

export function profileSnapshot() {
  const installed = installedBundles();
  const manifest = installed.dir ? readJson(join(installed.dir, 'package.json')) : undefined;
  const composition = manifest?.dsh?.profile?.composition;
  return {
    dir: installed.dir,
    error: installed.error,
    bundles: installed.bundles || [],
    dshVersion: runningDshVersion(),
    composition: ['headless', 'web'].includes(composition) ? composition : undefined,
  };
}

export function runningProfileName(argv = process.argv) {
  const index = argv.indexOf('--profile');
  const name = index >= 0 ? argv[index + 1] : undefined;
  return name && !name.startsWith('-') ? name : 'desktop';
}
