import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { evaluatePeers } from './peer.js';
import { loadPackage } from './load.js';
import { detectConflicts } from '../experimental/conflicts.js';

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
 *
 * With `candidate`, one extra package dir is evaluated for peers and joined into
 * the conflict scan. Conflict scanning loads each installed plugin's source with
 * a bounded `loadPackage` (phase publish); bounds are best-effort and any skip is
 * recorded in `limits`. Peer verdicts always complete regardless of bounds.
 */
export function scanProfile(profileDir, { dshVersion, candidate, maxPlugins = 30, perPluginMs = 2000 } = {}) {
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error('not a profile directory (no package.json): ' + profileDir);
  }
  const runtime = profileRuntimeVersion(profileDir, dshVersion);
  const limits = [];
  const plugins = [];
  const conflictPackages = [];
  let scanned = 0;

  const tryAddConflictSource = (name) => {
    if (scanned >= maxPlugins) {
      limits.push(`conflict scan skipped ${name}: maxPlugins ${maxPlugins} reached`);
      return;
    }
    const start = Date.now();
    try {
      const pkg = loadPackage(join(profileDir, 'node_modules', ...name.split('/')), { phase: 'publish' });
      if (Date.now() - start > perPluginMs) {
        limits.push(`conflict scan skipped ${name}: loadPackage exceeded ${perPluginMs}ms`);
        return;
      }
      conflictPackages.push(pkg);
      scanned += 1;
    } catch {
      limits.push(`conflict scan skipped ${name}: plugin source unreadable`);
    }
  };

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
    tryAddConflictSource(name);
  }

  if (typeof candidate === 'string') {
    const start = Date.now();
    try {
      const pkg = loadPackage(candidate, { phase: 'publish' });
      const peers = evaluatePeers(pkg.manifest, runtime);
      plugins.unshift({
        name: pkg.manifest.name || basename(candidate),
        version: typeof pkg.manifest.version === 'string' ? pkg.manifest.version : null,
        firstParty: false,
        candidate: true,
        runtime: runtime || null,
        verdict: runtime ? peers.verdict : 'unknown',
        unsatisfied: peers.unsatisfied,
        undecidable: peers.undecidable,
        allowCommand: undefined,
      });
      conflictPackages.unshift(pkg);
      if (Date.now() - start > perPluginMs) limits.push('candidate loadPackage exceeded ' + perPluginMs + 'ms');
    } catch {
      limits.push('candidate could not be loaded: ' + candidate);
    }
  }

  const conflicts = detectConflicts(conflictPackages);
  const summary = {
    total: plugins.length,
    willReject: plugins.filter((plugin) => plugin.verdict === 'will-reject').length,
    willLoad: plugins.filter((plugin) => plugin.verdict === 'will-load').length,
    noConstraint: plugins.filter((plugin) => plugin.verdict === 'no-constraint').length,
    unknown: plugins.filter((plugin) => plugin.verdict === 'unknown').length,
    firstParty: plugins.filter((plugin) => plugin.firstParty).length,
  };
  return { schemaVersion: 1, mode: 'profile-scan', profile: profileDir, runtime: runtime || null, plugins, conflicts, limits, summary };
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
  const conflictTotal = scan.conflicts?.summary?.total ?? 0;
  if (conflictTotal > 0) {
    lines.push('');
    lines.push('  conflicts (static pre-flight hints, not verdicts): ' + conflictTotal);
    for (const slot of scan.conflicts.slots) {
      lines.push('    slot ' + slot.resource + ': ' + slot.plugins.join(', '));
    }
    for (const tool of scan.conflicts.toolNames) {
      lines.push('    tool ' + tool.resource + ': ' + tool.plugins.join(', '));
    }
    for (const route of scan.conflicts.routes) {
      lines.push('    route ' + route.resource + ': ' + route.plugins.join(', '));
    }
    for (const key of scan.conflicts.configKeys) {
      lines.push('    config ' + key.resource + ': ' + key.plugins.join(', '));
    }
  }
  return lines.join('\n');
}