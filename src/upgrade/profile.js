import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function exactVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : undefined;
}

function installedVersion(profileDir, name, entry, profileManifest) {
  if (entry && typeof entry === 'object' && exactVersion(entry.version)) return entry.version;
  const manifestPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      if (exactVersion(manifest.version)) return manifest.version;
    } catch { /* use the profile declaration below */ }
  }
  return exactVersion({ ...(profileManifest?.dependencies || {}), ...(profileManifest?.devDependencies || {}) }[name]);
}

export function readProfile(profileDir) {
  if (!existsSync(profileDir) || !isDirectory(profileDir)) throw new Error('profile directory not found: ' + profileDir);
  const manifestPath = join(profileDir, 'package.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
  const declared = manifest?.dsh?.profile?.bundles;
  const composition = ['headless', 'web'].includes(manifest?.dsh?.profile?.composition) ? manifest.dsh.profile.composition : undefined;
  const plugins = [];
  const seen = new Set();
  if (Array.isArray(declared) && declared.length > 0) {
    for (const entry of declared) {
      const name = typeof entry === 'string'
        ? entry.trim()
        : entry && typeof entry === 'object'
          ? entry.name || entry.id || entry.package || entry.bundle || entry.plugin
          : undefined;
      if (typeof name !== 'string' || !name || seen.has(name)) continue;
      seen.add(name);
      plugins.push({ name, version: installedVersion(profileDir, name, entry, manifest), firstParty: name.startsWith('@deepseek-ai/'), source: 'dsh.profile.bundles' });
    }
    return { path: profileDir, manifest, plugins, source: 'dsh.profile.bundles', composition };
  }

  const nodeModulesDir = join(profileDir, 'node_modules');
  if (manifest === undefined && (!existsSync(nodeModulesDir) || !isDirectory(nodeModulesDir))) {
    throw new Error('not a profile directory (no package.json and no node_modules): ' + profileDir);
  }
  if (!existsSync(nodeModulesDir) || !isDirectory(nodeModulesDir)) {
    return { path: profileDir, manifest, plugins: [], source: 'none', composition };
  }
  const consider = (dir, fallbackName) => {
    const manifestFile = join(dir, 'package.json');
    if (!existsSync(manifestFile)) return;
    let pkg;
    try { pkg = readJson(manifestFile); } catch { return; }
    if (!pkg.dsh && !(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'))) return;
    const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : fallbackName;
    if (seen.has(name)) return;
    seen.add(name);
    plugins.push({ name, version: exactVersion(pkg.version), firstParty: name.startsWith('@deepseek-ai/'), source: 'node_modules' });
  };
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = join(nodeModulesDir, entry.name);
    if (!(entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(entryPath)))) continue;
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(entryPath, { withFileTypes: true })) {
        const childPath = join(entryPath, child.name);
        if (child.isDirectory() || (child.isSymbolicLink() && isDirectory(childPath))) consider(childPath, entry.name + '/' + child.name);
      }
    } else {
      consider(entryPath, entry.name);
    }
  }
  return { path: profileDir, manifest, plugins, source: 'node_modules', composition };
}
