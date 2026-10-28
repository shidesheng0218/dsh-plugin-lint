#!/usr/bin/env node
/**
 * dsh-plugin-upgrade-plan — plan a DSH upgrade from local compatibility-matrix data.
 *
 *   dsh-plugin-upgrade-plan --from <a> --to <b> --installed <profile> [--matrix <dir>] [--json]
 *   dsh-plugin-upgrade-plan --check-compatibility <plugin-dir> --target <version> [--json]
 *
 * Analysis is matrix-only: the cells under <matrix>/<plugin>/<dsh>[+web].json
 * record what the probe observed, and no network request is made. A plugin is
 * "compatible" only when a cell for that exact plugin version and target DSH
 * version was active; an untested version is reported as unknown, never as safe.
 *
 * Exit codes are part of the contract:
 *   analysis: 0 nothing to do · 1 a plugin needs an update or has no compatible
 *             version · 2 the run failed (including missing matrix data)
 *   --check-compatibility: 0 compatible · 1 incompatible · 2 unknown/no data
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackage } from '../src/load.js';
import { classifyCompatibilityDeclaration } from '../src/upgrade/compatibility.js';

const USAGE = [
  'dsh-plugin-upgrade-plan — matrix-based DSH upgrade planner (experimental)',
  '',
  'Usage',
  '  dsh-plugin-upgrade-plan --from <version> --to <version> --installed <profile-dir> [options]',
  '  dsh-plugin-upgrade-plan --check-compatibility <plugin-dir> --target <version> [options]',
  '',
  'Analysis mode joins the profile\'s installed plugins against the compatibility',
  'matrix and reports what happens on the target DSH version. The matrix is read',
  'from <matrix>/<plugin>/<dsh>[+web].json; no network request is made.',
  '',
  'Check mode reads the plugin\'s own package.json dsh.compatibility.dshReleases;',
  'it does not need matrix data.',
  '',
  'Options',
  '  --from <version>              current DSH version (printed in the report)',
  '  --to <version>                target DSH version (analysis mode, required)',
  '  --installed <dir>             profile directory whose dsh.profile.bundles are checked',
  '                                (analysis mode, required)',
  '  --matrix <dir>                matrix cells directory (default: ./matrix/cells)',
  '  --check-compatibility <dir>   plugin directory to check against --target',
  '  --target <version>            target DSH version for --check-compatibility',
  '  --json                        print only the JSON report on stdout',
  '  --auto-fix                    print an npm install command for plugins that need an update',
  '  -h, --help                    show this message',
  '',
  'Exit codes',
  '  analysis mode',
  '    0  no plugin needs an update and none is without a compatible version',
  '    1  at least one plugin needs an update, or has no compatible version',
  '    2  the run failed (bad arguments, unreadable profile, no matrix data,',
  '       or no cells for the target DSH version)',
  '  --check-compatibility',
  '    0  the plugin declares compatibility with the target version',
  '    1  the plugin declares incompatibility with the target version',
  '    2  unknown / no declaration for the target version',
  '',
  'The matrix cells are produced by the probe and are not shipped with the npm',
  'package; point --matrix at a checkout\'s matrix/cells or a generated snapshot.',
].join('\n');

/** Most favourable first; one plugin version has one cell per composition. */
const RANK = {
  active: 0,
  'awaiting-service': 1,
  'rejected-by-host': 2,
  'inactive-error': 3,
  'boot-failed': 4,
  'install-failed': 5,
};

const rankOf = (status) => RANK[status] ?? 9;

function die(message) {
  console.error('dsh-plugin-upgrade-plan: ' + message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    json: false,
    autoFix: false,
    help: false,
    from: undefined,
    to: undefined,
    installed: undefined,
    checkCompatibility: undefined,
    target: undefined,
    matrix: undefined,
  };
  const valueFlags = {
    '--from': 'from',
    '--to': 'to',
    '--installed': 'installed',
    '--check-compatibility': 'checkCompatibility',
    '--target': 'target',
    '--matrix': 'matrix',
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--auto-fix') { options.autoFix = true; continue; }
    if (Object.prototype.hasOwnProperty.call(valueFlags, arg)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) {
        die(arg + ' needs a value');
      }
      options[valueFlags[arg]] = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') die('unknown option: ' + arg);
    die('unexpected argument: ' + arg);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Load matrix cells. A cell file records
 *   { plugin: { name, version, ... }, dsh: { version, ... }, result: { status, ... } }
 * and the join key is "<plugin name>@<plugin version>" -> "<dsh version>" -> result.
 * One plugin version has one cell per composition (headless and web); only the
 * most favourable verdict per DSH version is kept, the same ranking the site
 * generator uses.
 */
function loadMatrixData(matrixDir) {
  const byKey = new Map();
  const versionsByPlugin = new Map();
  const dshVersions = new Set();
  const stats = { cells: 0, skipped: 0 };

  let pluginDirs;
  try {
    pluginDirs = readdirSync(matrixDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    die('cannot read matrix directory ' + matrixDir + ': ' + error.message);
  }

  for (const pluginDir of pluginDirs) {
    const dirPath = join(matrixDir, pluginDir.name);
    let cellFiles;
    try {
      cellFiles = readdirSync(dirPath).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const cellFile of cellFiles) {
      let cell;
      try {
        cell = readJson(join(dirPath, cellFile));
      } catch {
        stats.skipped += 1;
        continue;
      }
      const name = cell?.plugin?.name;
      const version = cell?.plugin?.version;
      const dshVersion = cell?.dsh?.version
        || cellFile.replace(/\+web\.json$/, '').replace(/\.json$/, '');
      const result = cell?.result;
      if (typeof name !== 'string' || !name
        || typeof version !== 'string' || !version
        || typeof dshVersion !== 'string' || !dshVersion
        || !result || typeof result.status !== 'string') {
        stats.skipped += 1;
        continue;
      }

      stats.cells += 1;
      dshVersions.add(dshVersion);
      const key = name + '@' + version;
      if (!byKey.has(key)) byKey.set(key, new Map());
      const perDsh = byKey.get(key);
      const existing = perDsh.get(dshVersion);
      if (existing === undefined || rankOf(result.status) < rankOf(existing.status)) {
        perDsh.set(dshVersion, result);
      }
      if (!versionsByPlugin.has(name)) versionsByPlugin.set(name, new Set());
      versionsByPlugin.get(name).add(version);
    }
  }

  return { byKey, versionsByPlugin, dshVersions, stats };
}

function compareVersionsAscending(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function compareVersionsDescending(a, b) {
  return b.localeCompare(a, undefined, { numeric: true });
}

/** Only an exact semver is usable as a matrix key; ranges are not guesses. */
function exactVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : undefined;
}

function installedVersion(profileDir, name, entry, profileManifest) {
  if (entry !== null && typeof entry === 'object' && typeof entry.version === 'string' && entry.version) {
    return entry.version;
  }
  const manifestPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      if (typeof manifest.version === 'string' && manifest.version) return manifest.version;
    } catch {
      // fall through to the profile manifest
    }
  }
  const dependencies = {
    ...(profileManifest?.dependencies || {}),
    ...(profileManifest?.devDependencies || {}),
  };
  return exactVersion(dependencies[name]);
}

/**
 * A profile declares its bundles in package.json (dsh.profile.bundles, entries
 * are strings or objects). Only when that declaration is absent or empty does
 * the reader fall back to scanning node_modules, because the declaration is the
 * authoritative list of what the profile loads.
 */
function readProfile(profileDir) {
  if (!existsSync(profileDir) || !isDirectory(profileDir)) {
    throw new Error('profile directory not found: ' + profileDir);
  }

  const manifestPath = join(profileDir, 'package.json');
  let manifest;
  if (existsSync(manifestPath)) {
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      throw new Error('cannot read ' + manifestPath + ': ' + error.message);
    }
  }

  const declared = manifest?.dsh?.profile?.bundles;
  const plugins = [];
  const seen = new Set();

  if (Array.isArray(declared) && declared.length > 0) {
    for (const entry of declared) {
      const name = typeof entry === 'string'
        ? entry.trim()
        : (entry && typeof entry === 'object'
            ? (entry.name || entry.id || entry.package || entry.bundle || entry.plugin)
            : undefined);
      if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
      seen.add(name);
      plugins.push({
        name,
        version: installedVersion(profileDir, name, entry, manifest),
        firstParty: name.startsWith('@deepseek-ai/'),
        source: 'dsh.profile.bundles',
      });
    }
    return { manifest, plugins, source: 'dsh.profile.bundles' };
  }

  const nodeModulesDir = join(profileDir, 'node_modules');
  if (manifest === undefined && (!existsSync(nodeModulesDir) || !isDirectory(nodeModulesDir))) {
    throw new Error('not a profile directory (no package.json and no node_modules): ' + profileDir);
  }
  if (!existsSync(nodeModulesDir) || !isDirectory(nodeModulesDir)) {
    // A profile may legitimately have no bundles: report zero plugins, not a
    // failed run.
    return { manifest, plugins: [], source: 'none' };
  }

  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    throw new Error('cannot read ' + nodeModulesDir + ': ' + error.message);
  }

  const consider = (pkgDir, fallbackName) => {
    const manifestFile = join(pkgDir, 'package.json');
    if (!existsSync(manifestFile)) return;
    let pkgManifest;
    try {
      pkgManifest = readJson(manifestFile);
    } catch {
      return;
    }
    const isPlugin = Boolean(pkgManifest.dsh)
      || (Array.isArray(pkgManifest.keywords) && pkgManifest.keywords.includes('dsh-plugin'));
    if (!isPlugin) return;
    const name = typeof pkgManifest.name === 'string' && pkgManifest.name ? pkgManifest.name : fallbackName;
    if (seen.has(name)) return;
    seen.add(name);
    plugins.push({
      name,
      version: typeof pkgManifest.version === 'string' ? pkgManifest.version : undefined,
      firstParty: name.startsWith('@deepseek-ai/'),
      source: 'node_modules',
    });
  };

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = join(nodeModulesDir, entry.name);
    const entryIsDir = entry.isDirectory()
      || (entry.isSymbolicLink() && isDirectory(entryPath));
    if (!entryIsDir) continue;
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        const childPath = join(entryPath, child.name);
        if (!(child.isDirectory() || (child.isSymbolicLink() && isDirectory(childPath)))) continue;
        consider(childPath, entry.name + '/' + child.name);
      }
    } else {
      consider(entryPath, entry.name);
    }
  }

  return { manifest, plugins, source: 'node_modules' };
}

/** The best matrix-tested version of a plugin that was active on the target. */
function bestActiveVersion(matrix, name, targetDsh, currentVersion) {
  const versions = matrix.versionsByPlugin.get(name);
  if (!versions) return undefined;
  const active = [...versions]
    .filter((version) => version !== currentVersion)
    .filter((version) => matrix.byKey.get(name + '@' + version)?.get(targetDsh)?.status === 'active')
    .sort(compareVersionsDescending);
  return active[0];
}

function classifyPlugin(plugin, matrix, targetDsh) {
  const base = {
    name: plugin.name,
    version: plugin.version ?? null,
    firstParty: false,
  };

  if (!plugin.version) {
    return {
      ...base,
      category: 'unknown',
      status: 'unknown',
      reason: 'installed version unknown (not found in node_modules or profile dependencies)',
    };
  }

  const perDsh = matrix.byKey.get(plugin.name + '@' + plugin.version);
  const result = perDsh?.get(targetDsh);
  const testedVersions = [...(matrix.versionsByPlugin.get(plugin.name) || new Set([plugin.version]))]
    .sort(compareVersionsAscending);

  if (result === undefined) {
    const covered = matrix.versionsByPlugin.has(plugin.name);
    return {
      ...base,
      category: 'unknown',
      status: 'unknown',
      reason: covered
        ? 'version ' + plugin.version + ' is not covered by the matrix for DSH ' + targetDsh
          + ' (tested versions: ' + testedVersions.join(', ') + ')'
        : 'plugin is not covered by the matrix',
      testedVersions,
    };
  }

  const status = result.status;
  if (status === 'active') {
    return { ...base, category: 'compatible', status, composition: result.composition };
  }
  if (status === 'awaiting-service') {
    return {
      ...base,
      category: 'untested',
      status,
      composition: result.composition,
      reason: 'the matrix recorded awaiting-service: this composition did not provide a service the plugin waits for. Not a failure.',
    };
  }

  const recommendedVersion = bestActiveVersion(matrix, plugin.name, targetDsh, plugin.version);
  if (recommendedVersion !== undefined) {
    return {
      ...base,
      category: 'needsUpdate',
      status,
      composition: result.composition,
      recommendedVersion,
      reason: 'matrix verdict on DSH ' + targetDsh + ' is "' + status
        + '"; version ' + recommendedVersion + ' was active on the same target',
    };
  }

  return {
    ...base,
    category: 'noCompatibleVersion',
    status,
    composition: result.composition,
    testedVersions,
    reason: 'matrix verdict on DSH ' + targetDsh + ' is "' + status
      + '" and no tested version was active',
  };
}

function buildReport(profile, matrix, fromVersion, toVersion) {
  const categories = {
    compatible: [],
    untested: [],
    needsUpdate: [],
    noCompatibleVersion: [],
    unknown: [],
    firstParty: [],
  };

  for (const plugin of profile.plugins) {
    if (plugin.firstParty) {
      categories.firstParty.push({
        name: plugin.name,
        version: plugin.version ?? null,
        firstParty: true,
        category: 'firstParty',
        status: 'not-covered',
        reason: 'first-party bundle; the compatibility matrix does not cover the harness\'s own packages',
      });
      continue;
    }
    const classified = classifyPlugin(plugin, matrix, toVersion);
    categories[classified.category].push(classified);
  }

  const installTargets = categories.needsUpdate
    .filter((plugin) => plugin.recommendedVersion)
    .map((plugin) => plugin.name + '@' + plugin.recommendedVersion);

  const community = profile.plugins.length - categories.firstParty.length;
  const summary = {
    total: profile.plugins.length,
    community,
    compatible: categories.compatible.length,
    untested: categories.untested.length,
    needsUpdate: categories.needsUpdate.length,
    noCompatibleVersion: categories.noCompatibleVersion.length,
    unknown: categories.unknown.length,
    firstParty: categories.firstParty.length,
    needAction: categories.needsUpdate.length + categories.noCompatibleVersion.length,
  };

  return {
    mode: 'upgrade-plan',
    from: fromVersion,
    to: toVersion,
    profile: {
      path: profile.path,
      source: profile.source,
      bundles: profile.plugins.length,
    },
    matrix: {
      dir: matrix.dir,
      cells: matrix.stats.cells,
      dshVersions: [...matrix.dshVersions].sort(compareVersionsAscending),
    },
    categories,
    summary,
    installCommand: installTargets.length > 0 ? 'npm install ' + installTargets.join(' ') : null,
  };
}

function printAnalysis(report, options) {
  const { summary, categories } = report;
  console.log('\n📊 DSH Upgrade Impact Analysis (experimental)');
  console.log('   ' + report.from + ' → ' + report.to + '\n');
  console.log('Profile: ' + report.profile.path + ' (' + summary.total + ' plugin(s), source: ' + report.profile.source + ')');
  console.log('Matrix:  ' + report.matrix.dir + ' (' + report.matrix.cells + ' cell(s), DSH versions: '
    + report.matrix.dshVersions.join(', ') + ')\n');

  console.log('='.repeat(70));
  console.log('UPGRADE COMPATIBILITY REPORT');
  console.log('='.repeat(70) + '\n');

  if (summary.total === 0) {
    console.log('No DSH plugins found in this profile; there is nothing to plan.\n');
  }

  if (categories.compatible.length > 0) {
    console.log('✅ ' + categories.compatible.length + ' plugin(s) already compatible on ' + report.to + ':');
    for (const plugin of categories.compatible) {
      console.log('   - ' + plugin.name + '@' + plugin.version);
    }
    console.log('');
  }

  if (categories.untested.length > 0) {
    console.log('❔ ' + categories.untested.length + ' plugin(s) were not exercised on the target version:');
    for (const plugin of categories.untested) {
      console.log('   - ' + plugin.name + '@' + plugin.version + ': ' + plugin.reason);
    }
    console.log('');
  }

  if (categories.needsUpdate.length > 0) {
    console.log('⚠️  ' + categories.needsUpdate.length + ' plugin(s) need update:');
    for (const plugin of categories.needsUpdate) {
      console.log('   - ' + plugin.name + ': ' + plugin.version + ' → ' + plugin.recommendedVersion
        + ' (the matrix observed that version active on ' + report.to + ')');
    }
    console.log('');
    if (options.autoFix && report.installCommand) {
      console.log('🔧 Auto-fix command:\n');
      console.log('   ' + report.installCommand + '\n');
    }
  }

  if (categories.noCompatibleVersion.length > 0) {
    console.log('❌ ' + categories.noCompatibleVersion.length + ' plugin(s) have no compatible tested version on ' + report.to + ':');
    for (const plugin of categories.noCompatibleVersion) {
      console.log('   - ' + plugin.name + '@' + plugin.version);
      console.log('     → tested versions: ' + plugin.testedVersions.join(', ')
        + '; none was active. Consider an alternative or contact the maintainer.');
    }
    console.log('');
  }

  if (categories.unknown.length > 0) {
    console.log('❓ ' + categories.unknown.length + ' plugin(s) with unknown compatibility:');
    for (const plugin of categories.unknown) {
      console.log('   - ' + plugin.name + (plugin.version ? '@' + plugin.version : '') + ': ' + plugin.reason);
    }
    console.log('');
  }

  if (categories.firstParty.length > 0) {
    console.log('🛡️  ' + categories.firstParty.length + ' first-party bundle(s); the matrix does not cover them:');
    for (const plugin of categories.firstParty) {
      console.log('   - ' + plugin.name + (plugin.version ? '@' + plugin.version : ''));
    }
    console.log('');
  }

  console.log('='.repeat(70) + '\n');
  console.log('📈 Summary:');
  console.log('   Community plugins: ' + summary.community + '/' + summary.total);
  if (summary.community > 0) {
    console.log('   Safe to upgrade: ' + summary.compatible + '/' + summary.community);
    console.log('   Need action: ' + summary.needAction + '/' + summary.community);
    console.log('   Not covered: ' + summary.unknown + '/' + summary.community);
  }
  console.log('   First-party (not covered by the matrix): ' + summary.firstParty + '\n');

  if (summary.needAction > 0) {
    console.log('⚠️  Review the plugins that need an update before upgrading DSH.\n');
  } else if (summary.community === 0) {
    console.log('There are no community plugins to check; the first-party bundles are the host itself.\n');
  } else if (summary.unknown > 0) {
    console.log('❔ Nothing to update was found, but ' + summary.unknown
      + ' community plugin(s) are not covered by the matrix. It cannot confirm those.\n');
  } else {
    console.log('✅ Every community plugin has a positive matrix verdict on ' + report.to + '.\n');
  }
}

function runCheckCompatibility(options) {
  const dir = options.checkCompatibility;
  let pkg;
  try {
    pkg = loadPackage(dir);
  } catch (error) {
    die('cannot load plugin ' + JSON.stringify(dir) + ': ' + error.message);
  }
  const manifest = pkg.manifest || {};
  const declared = manifest.dsh?.compatibility?.dshReleases;
  const declaredRecord = declared !== null && typeof declared === 'object' && !Array.isArray(declared)
    ? declared
    : undefined;
  const targetVersion = options.target;

  let status;
  let declaredStatus;
  let reason;
  if (declaredRecord === undefined || Object.keys(declaredRecord).length === 0) {
    status = 'unknown';
    reason = 'the plugin does not declare dsh.compatibility.dshReleases';
  } else if (!Object.prototype.hasOwnProperty.call(declaredRecord, targetVersion)) {
    status = 'unknown';
    reason = 'the plugin does not declare compatibility with DSH ' + targetVersion
      + ' (declares: ' + Object.keys(declaredRecord).join(', ') + ')';
  } else {
    declaredStatus = declaredRecord[targetVersion];
    const classification = classifyCompatibilityDeclaration(declaredStatus);
    if (classification === 'incompatible') {
      status = 'incompatible';
      reason = 'the plugin declares incompatibility with DSH ' + targetVersion;
    } else if (classification === 'compatible') {
      status = 'compatible';
      reason = 'the plugin declares compatibility with DSH ' + targetVersion;
    } else {
      status = 'unknown';
      reason = 'the compatibility declaration for DSH ' + targetVersion + ' is pending or unrecognized';
    }
  }

  const payload = {
    mode: 'check-compatibility',
    plugin: {
      name: manifest.name,
      version: manifest.version,
      path: dir,
    },
    dshVersion: targetVersion,
    status,
    declaredStatus: declaredStatus ?? null,
    declared: declaredRecord ?? null,
    reason,
  };

  const exitCode = status === 'compatible' ? 0 : status === 'incompatible' ? 1 : 2;

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('\n🔍 Checking plugin compatibility with DSH ' + targetVersion + '\n');
    console.log('Plugin: ' + (manifest.name || dir) + '@' + (manifest.version || 'unknown') + '\n');
    const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
    if (status === 'compatible') {
      console.log('✅ ' + reason);
      console.log('   Status: ' + show(declaredStatus));
      const verifiedBy = manifest.dsh?.compatibility?.verifiedBy;
      if (verifiedBy) console.log('   Verified by: ' + verifiedBy);
    } else if (status === 'incompatible') {
      console.log('❌ ' + reason);
      console.log('   Status: ' + show(declaredStatus));
      console.log('   Declared versions:');
      for (const [version, value] of Object.entries(declaredRecord)) {
        console.log('   - ' + version + ': ' + show(value));
      }
    } else {
      console.log('❔ ' + reason);
      if (declaredRecord !== undefined) {
        console.log('\n   Declared compatible versions:');
        for (const [version, value] of Object.entries(declaredRecord)) {
          console.log('   - ' + version + ': ' + show(value));
        }
      } else {
        console.log('\n   Add to package.json:');
        console.log('   "dsh": {');
        console.log('     "compatibility": {');
        console.log('       "dshReleases": {');
        console.log('         "' + targetVersion + '": "compatible"');
        console.log('       }');
        console.log('     }');
        console.log('   }');
      }
    }
    console.log('');
    console.log('Exit codes: 0 compatible · 1 incompatible · 2 unknown/no data.\n');
  }

  process.exit(exitCode);
}

function runAnalysis(options) {
  if (options.from === undefined || options.to === undefined) {
    die('analysis mode needs --from <version> and --to <version> (or use --check-compatibility)');
  }
  if (options.installed === undefined) {
    die('analysis mode needs --installed <profile-dir>; the matrix alone cannot name installed plugins');
  }

  const profileDir = options.installed;
  if (!existsSync(profileDir) || !isDirectory(profileDir)) {
    die('profile directory not found: ' + profileDir);
  }

  const matrixDir = options.matrix !== undefined ? options.matrix : join(process.cwd(), 'matrix', 'cells');
  if (!existsSync(matrixDir) || !isDirectory(matrixDir)) {
    die('matrix directory not found: ' + matrixDir
      + '\nPass --matrix <dir> pointing at a matrix/cells snapshot; the npm package does not ship matrix data.');
  }

  let profile;
  try {
    profile = readProfile(profileDir);
    profile.path = profileDir;
  } catch (error) {
    die(error.message);
  }

  const matrix = loadMatrixData(matrixDir);
  matrix.dir = matrixDir;
  if (matrix.stats.cells === 0) {
    die('no matrix cells found under ' + matrixDir + ' (no data for ' + options.to + ')');
  }
  if (matrix.stats.skipped > 0) {
    console.error('Warning: skipped ' + matrix.stats.skipped + ' malformed matrix cell(s) under ' + matrixDir);
  }
  const knownVersions = [...matrix.dshVersions].sort(compareVersionsAscending);
  if (!matrix.dshVersions.has(options.to)) {
    die('the matrix has no cells for DSH ' + options.to
      + ' (it covers: ' + (knownVersions.length ? knownVersions.join(', ') : 'nothing') + ')');
  }

  const report = buildReport(profile, matrix, options.from, options.to);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printAnalysis(report, options);
  }

  process.exit(report.summary.needAction > 0 ? 1 : 0);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const checkMode = options.checkCompatibility !== undefined || options.target !== undefined;
const analysisMode = options.from !== undefined || options.to !== undefined || options.installed !== undefined;

if (checkMode && analysisMode) {
  die('choose one mode: analysis (--from/--to/--installed) or --check-compatibility/--target');
}

if (options.matrix !== undefined && (!existsSync(options.matrix) || !isDirectory(options.matrix))) {
  die('matrix directory not found: ' + options.matrix);
}

if (checkMode) {
  if (options.checkCompatibility === undefined) die('--target needs --check-compatibility <plugin-dir>');
  if (options.target === undefined) die('--check-compatibility needs --target <version>');
  runCheckCompatibility(options);
} else if (analysisMode) {
  runAnalysis(options);
} else {
  die('missing arguments; run with --help for usage');
}
