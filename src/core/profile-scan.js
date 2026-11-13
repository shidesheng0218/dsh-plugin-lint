import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { evaluatePeers } from './peer.js';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** The host gates on the app-boot package version; fall back to the dsh package. */
export function profileRuntimeVersion(profileDir, override) {
  if (override) return override;
  for (const path of [
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]) {
    const version = readJson(path)?.version;
    if (typeof version === 'string' && version) return version;
  }
  return undefined;
}

function declaredBundles(manifest) {
  const declared = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(declared)) return [];
  const names = [];
  for (const entry of declared) {
    const name = typeof entry === 'string'
      ? entry
      : entry?.name || entry?.id || entry?.package || entry?.bundle || entry?.plugin;
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** dsh.profile.bundles when present, otherwise every package in node_modules. */
export function installedBundles(profileDir) {
  const manifest = readJson(join(profileDir, 'package.json'));
  const declared = declaredBundles(manifest);
  if (declared.length > 0) return declared;
  const nodeModules = join(profileDir, 'node_modules');
  if (!existsSync(nodeModules)) return [];
  const names = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      let children = [];
      try { children = readdirSync(path, { withFileTypes: true }); } catch { children = []; }
      for (const child of children) names.push(entry.name + '/' + child.name);
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

function allowCommand(profileDir, name, version, runtime) {
  if (!version || !runtime) return undefined;
  return 'dsh plugin --profile ' + basename(profileDir)
    + ' allow-version ' + name + '@' + version
    + ' --dsh-version ' + runtime + ' --accept-risk';
}

/**
 * Offline admission scan of an installed profile. It reads manifests only; it
 * never imports a plugin or touches the running host.
 */
export function scanProfile(profileDir, { dshVersion } = {}) {
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error('not a profile directory (no package.json): ' + profileDir);
  }
  const runtime = profileRuntimeVersion(profileDir, dshVersion);
  const plugins = [];
  for (const name of installedBundles(profileDir)) {
    const manifest = readJson(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'));
    if (!manifest) continue;
    const peers = evaluatePeers(manifest, runtime);
    plugins.push({
      name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      firstParty: name.startsWith('@deepseek-ai/'),
      runtime: runtime || null,
      verdict: runtime ? peers.verdict : 'unknown',
      unsatisfied: peers.unsatisfied,
      undecidable: peers.undecidable,
      allowCommand: peers.verdict === 'will-reject' ? allowCommand(profileDir, name, manifest.version, runtime) : undefined,
    });
  }
  const summary = {
    total: plugins.length,
    willReject: plugins.filter((plugin) => plugin.verdict === 'will-reject').length,
    willLoad: plugins.filter((plugin) => plugin.verdict === 'will-load').length,
    noConstraint: plugins.filter((plugin) => plugin.verdict === 'no-constraint').length,
    unknown: plugins.filter((plugin) => plugin.verdict === 'unknown').length,
    firstParty: plugins.filter((plugin) => plugin.firstParty).length,
  };
  return { schemaVersion: 1, mode: 'profile-scan', profile: profileDir, runtime: runtime || null, plugins, summary };
}

export function formatProfileScan(scan) {
  const lines = [
    'profile ' + scan.profile + ' · runtime ' + (scan.runtime || 'unknown'),
    '  ' + scan.summary.total + ' bundle(s) · ' + scan.summary.willReject + ' will-reject · '
      + scan.summary.willLoad + ' will-load · ' + scan.summary.unknown + ' unknown',
  ];
  for (const plugin of scan.plugins) {
    if (plugin.firstParty && plugin.verdict !== 'will-reject') continue;
    if (plugin.verdict === 'will-reject') {
      lines.push('  ✗ ' + plugin.name + '@' + (plugin.version || '?') + '  will-reject');
      for (const peer of plugin.unsatisfied) {
        lines.push('      ' + peer.name + ' "' + peer.range + '" does not accept ' + scan.runtime);
      }
      if (plugin.allowCommand) lines.push('      grant an exact exemption: ' + plugin.allowCommand);
    } else if (plugin.verdict === 'unknown') {
      lines.push('  ? ' + plugin.name + '@' + (plugin.version || '?') + '  unknown (no runtime version or an undecidable range)');
    } else {
      lines.push('  ✓ ' + plugin.name + '@' + (plugin.version || '?') + '  ' + plugin.verdict);
    }
  }
  return lines.join('\n');
}