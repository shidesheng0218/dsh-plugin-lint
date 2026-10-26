#!/usr/bin/env node
/**
 * Generate upgrade path recommendations when DSH version changes.
 * 
 * Usage:
 *   dsh-plugin-upgrade-plan --from 0.2.0-rc.2 --to 0.3.0 [--installed <profile-dir>]
 *   dsh-plugin-upgrade-plan --check-compatibility <plugin-dir> --target 0.3.0
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackage } from '../src/load.js';

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

function hasArg(name) {
  return args.includes(name);
}

const fromVersion = getArg('--from');
const toVersion = getArg('--to');
const targetVersion = getArg('--target');
const installedDir = getArg('--installed');
const pluginDir = getArg('--check-compatibility');

if (hasArg('--help') || hasArg('-h')) {
  console.log(`
DSH Plugin Upgrade Path Generator

Usage:
  dsh-plugin-upgrade-plan --from <version> --to <version> [options]
  dsh-plugin-upgrade-plan --check-compatibility <dir> --target <version>

Options:
  --from <version>              Current DSH version
  --to <version>                Target DSH version
  --installed <dir>             Profile directory with installed plugins
  --check-compatibility <dir>   Check if a plugin is compatible with target
  --target <version>            Target DSH version for compatibility check
  --json                        Output as JSON
  --auto-fix                    Generate npm install command

Examples:
  # Check upgrade impact for installed plugins
  dsh-plugin-upgrade-plan --from 0.2.0-rc.2 --to 0.3.0 --installed ~/.dsh/profiles/default

  # Check if specific plugin is compatible
  dsh-plugin-upgrade-plan --check-compatibility ./my-plugin --target 0.3.0
`);
  process.exit(0);
}

/**
 * Load compatibility matrix data from matrix/cells/
 */
/** Most favourable first; used to pick between composition cells. */
const RANK = { active: 0, 'awaiting-service': 1, 'rejected-by-host': 2, 'inactive-error': 3, 'boot-failed': 4, 'install-failed': 5 };
function rankOf(status) {
  return RANK[status] ?? 9;
}

function loadMatrixData(matrixDir) {
  const cells = new Map(); // plugin@version → { dshVersion → result }
  
  if (!existsSync(matrixDir)) return cells;

  try {
    const pluginDirs = readdirSync(matrixDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const pluginDirName of pluginDirs) {
      const pluginPath = join(matrixDir, pluginDirName);
      const cellFiles = readdirSync(pluginPath)
        .filter(f => f.endsWith('.json'));

      for (const cellFile of cellFiles) {
        try {
          const cellData = JSON.parse(readFileSync(join(pluginPath, cellFile), 'utf8'));
          // A cell records { plugin: { name, version }, dsh: { version, … },
          // result: { status, … } }. The first version of this reader used the
          // whole objects as Map keys, so nothing ever matched.
          const name = cellData.plugin?.name || pluginDirName;
          const version = cellData.plugin?.version;
          const dshVersion = cellData.dsh?.version || cellFile.replace('.json', '').replace('+web', '');
          if (!dshVersion || !cellData.result) continue;

          const record = (key) => {
            if (!cells.has(key)) cells.set(key, {});
            const existing = cells.get(key)[dshVersion];
            // One plugin has a cell per composition. Keep the most favourable
            // verdict, the same ranking the site generator uses.
            if (!existing || rankOf(cellData.result.status) < rankOf(existing.status)) {
              cells.get(key)[dshVersion] = cellData.result;
            }
          };
          record(name);
          if (version) record(`${name}@${version}`);
        } catch (err) {
          // Skip malformed cells
        }
      }
    }
  } catch (err) {
    console.error(`Warning: Could not load matrix data: ${err.message}`);
  }

  return cells;
}

/**
 * Get installed plugins from a profile directory.
 */
function getInstalledPlugins(profileDir) {
  const plugins = [];
  const nodeModulesDir = join(profileDir, 'node_modules');
  
  if (!existsSync(nodeModulesDir)) {
    return plugins;
  }

  try {
    const entries = readdirSync(nodeModulesDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('@')) {
          // Scoped package
          const scopePath = join(nodeModulesDir, entry.name);
          const scopedPackages = readdirSync(scopePath, { withFileTypes: true });
          for (const pkg of scopedPackages) {
            if (pkg.isDirectory()) {
              const pkgPath = join(scopePath, pkg.name);
              const manifestPath = join(pkgPath, 'package.json');
              if (existsSync(manifestPath)) {
                try {
                  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                  if (manifest.dsh || manifest.keywords?.includes('dsh-plugin')) {
                    plugins.push({
                      name: `${entry.name}/${pkg.name}`,
                      version: manifest.version,
                      path: pkgPath,
                      manifest
                    });
                  }
                } catch {}
              }
            }
          }
        } else {
          // Regular package
          const pkgPath = join(nodeModulesDir, entry.name);
          const manifestPath = join(pkgPath, 'package.json');
          if (existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
              if (manifest.dsh || manifest.keywords?.includes('dsh-plugin')) {
                plugins.push({
                  name: entry.name,
                  version: manifest.version,
                  path: pkgPath,
                  manifest
                });
              }
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error reading installed plugins: ${err.message}`);
  }

  return plugins;
}

/**
 * Check compatibility status for a plugin.
 */
function checkCompatibility(pluginName, pluginVersion, targetDshVersion, matrixData) {
  const key = `${pluginName}@${pluginVersion}`;
  const altKey = pluginName; // Try without version
  
  const compat = matrixData.get(key) || matrixData.get(altKey);
  
  if (!compat) {
    return { status: 'unknown', reason: 'No matrix data available' };
  }

  const result = compat[targetDshVersion];
  
  if (!result) {
    return { status: 'unknown', reason: 'Not tested with target version' };
  }

  return {
    status: result.status || 'unknown',
    details: result
  };
}

/**
 * Find newer versions of a plugin that work with target DSH.
 */
async function findCompatibleVersions(pluginName, targetDshVersion) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pluginName)}`);
    if (!response.ok) return [];

    const data = await response.json();
    const versions = Object.keys(data.versions || {});
    const compatible = [];

    for (const version of versions) {
      const manifest = data.versions[version];
      const declared = manifest.dsh?.compatibility?.dshReleases;
      
      if (declared && declared[targetDshVersion]) {
        compatible.push({
          version,
          compatibility: declared[targetDshVersion],
          publishedAt: data.time?.[version]
        });
      }
    }

    compatible.sort((a, b) => {
      // Sort by semver (simple string comparison for now)
      return b.version.localeCompare(a.version, undefined, { numeric: true });
    });

    return compatible;
  } catch (err) {
    return [];
  }
}

/**
 * Generate upgrade plan.
 */
async function generateUpgradePlan() {
  if (!fromVersion || !toVersion) {
    console.error('Error: --from and --to versions required');
    process.exit(1);
  }

  console.log(`\n📊 DSH Upgrade Impact Analysis`);
  console.log(`   ${fromVersion} → ${toVersion}\n`);

  const matrixDir = join(process.cwd(), 'matrix', 'cells');
  const matrixData = loadMatrixData(matrixDir);

  let plugins = [];
  
  if (installedDir) {
    plugins = getInstalledPlugins(installedDir);
    console.log(`Found ${plugins.length} DSH plugin(s) in ${installedDir}\n`);
  } else {
    console.log(`ℹ️  Use --installed <profile-dir> to check actual installed plugins\n`);
    console.log(`Analyzing based on matrix data only...\n`);
  }

  const categories = {
    compatible: [],
    untested: [],
    needsUpdate: [],
    noCompatibleVersion: [],
    unknown: []
  };

  for (const plugin of plugins) {
    const compat = checkCompatibility(plugin.name, plugin.version, toVersion, matrixData);
    
    // The matrix speaks in probe verdicts (active, awaiting-service,
    // rejected-by-host, …), not in a "compatible" flag. Treating the absence
    // of that flag as incompatibility made every plugin look broken.
    if (compat.status === 'active') {
      categories.compatible.push(plugin);
    } else if (compat.status === 'awaiting-service') {
      categories.untested.push({ ...plugin, reason: 'This composition did not provide a service it waits for.' });
    } else if (compat.status === 'unknown') {
      categories.unknown.push({ ...plugin, reason: compat.reason });
    } else {
      // Try to find compatible version
      const compatibleVersions = await findCompatibleVersions(plugin.name, toVersion);
      
      if (compatibleVersions.length > 0) {
        categories.needsUpdate.push({
          ...plugin,
          recommendedVersion: compatibleVersions[0].version,
          currentVersion: plugin.version
        });
      } else {
        categories.noCompatibleVersion.push(plugin);
      }
    }
  }

  // Report
  console.log(`${'='.repeat(70)}`);
  console.log(`UPGRADE COMPATIBILITY REPORT`);
  console.log(`${'='.repeat(70)}\n`);

  if (categories.compatible.length > 0) {
    console.log(`✅ ${categories.compatible.length} plugin(s) already compatible:`);
    for (const p of categories.compatible) {
      console.log(`   - ${p.name}@${p.version}`);
    }
    console.log();
  }

  if (categories.untested.length > 0) {
    console.log(`❔ ${categories.untested.length} plugin(s) were not exercised on the target version:`);
    for (const p of categories.untested) {
      console.log(`   - ${p.name}@${p.version}: ${p.reason} Not a failure — the probe could not test it here.`);
    }
    console.log();
  }

  if (categories.needsUpdate.length > 0) {
    console.log(`⚠️  ${categories.needsUpdate.length} plugin(s) need update:`);
    for (const p of categories.needsUpdate) {
      console.log(`   - ${p.name}: ${p.currentVersion} → ${p.recommendedVersion}`);
    }
    console.log();

    if (hasArg('--auto-fix')) {
      const installCmd = categories.needsUpdate
        .map(p => `${p.name}@${p.recommendedVersion}`)
        .join(' ');
      console.log(`🔧 Auto-fix command:\n`);
      console.log(`   npm install ${installCmd}\n`);
    }
  }

  if (categories.noCompatibleVersion.length > 0) {
    console.log(`❌ ${categories.noCompatibleVersion.length} plugin(s) have no version declaring compatibility with ${toVersion}:`);
    for (const p of categories.noCompatibleVersion) {
      console.log(`   - ${p.name}@${p.version}`);
      console.log(`     → Consider finding alternative or contact maintainer`);
    }
    console.log();
  }

  if (categories.unknown.length > 0) {
    console.log(`❓ ${categories.unknown.length} plugin(s) with unknown compatibility:`);
    for (const p of categories.unknown) {
      console.log(`   - ${p.name}@${p.version}: ${p.reason}`);
    }
    console.log();
  }

  console.log(`${'='.repeat(70)}\n`);

  // Summary
  const total = plugins.length;
  const safe = categories.compatible.length;
  const needAction = categories.needsUpdate.length + categories.noCompatibleVersion.length;

  console.log(`📈 Summary:`);
  console.log(`   Safe to upgrade: ${safe}/${total}`);
  console.log(`   Need action: ${needAction}/${total}`);
  console.log(`   Unknown: ${categories.unknown.length}/${total}\n`);

  if (needAction === 0 && categories.unknown.length === 0) {
    console.log(`✅ All plugins are compatible. Safe to upgrade!\n`);
  } else if (needAction > 0) {
    console.log(`⚠️  Review plugins that need updates before upgrading DSH.\n`);
  }
}

/**
 * Check single plugin compatibility.
 */
async function checkSinglePlugin() {
  if (!pluginDir || !targetVersion) {
    console.error('Error: --check-compatibility <dir> and --target <version> required');
    process.exit(1);
  }

  console.log(`\n🔍 Checking plugin compatibility with DSH ${targetVersion}\n`);

  try {
    const pkg = loadPackage(pluginDir);
    const manifest = pkg.manifest;

    console.log(`Plugin: ${manifest.name}@${manifest.version}\n`);

    // Check declared compatibility
    const declared = manifest.dsh?.compatibility?.dshReleases;
    
    if (declared && declared[targetVersion]) {
      console.log(`✅ Plugin declares compatibility with ${targetVersion}`);
      console.log(`   Status: ${declared[targetVersion]}`);
      
      const verifiedBy = manifest.dsh?.compatibility?.verifiedBy;
      if (verifiedBy) {
        console.log(`   Verified by: ${verifiedBy}`);
      }
    } else if (declared) {
      console.log(`⚠️  Plugin does not declare compatibility with ${targetVersion}`);
      console.log(`\n   Declared compatible versions:`);
      for (const [version, status] of Object.entries(declared)) {
        console.log(`   - ${version}: ${status}`);
      }
    } else {
      console.log(`❌ Plugin does not declare any DSH compatibility information`);
      console.log(`\n   Add to package.json:`);
      console.log(`   "dsh": {`);
      console.log(`     "compatibility": {`);
      console.log(`       "dshReleases": {`);
      console.log(`         "${targetVersion}": "compatible"`);
      console.log(`       }`);
      console.log(`     }`);
      console.log(`   }`);
    }

    console.log();

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Main execution
if (pluginDir && targetVersion) {
  await checkSinglePlugin();
} else if (fromVersion && toVersion) {
  await generateUpgradePlan();
} else {
  console.error('Invalid arguments. Use --help for usage information.');
  process.exit(1);
}
