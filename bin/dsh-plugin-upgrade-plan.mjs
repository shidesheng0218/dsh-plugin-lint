#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackage } from '../src/load.js';
import { classifyCompatibilityDeclaration } from '../src/upgrade/compatibility.js';
import { planUpgrade } from '../src/upgrade/planner.js';

const USAGE = [
  'dsh-plugin-upgrade-plan — matrix-based DSH upgrade planner (experimental)',
  '',
  'Usage',
  '  dsh-plugin-upgrade-plan --from <version> --to <version> --installed <profile-dir> [options]',
  '  dsh-plugin-upgrade-plan --check-compatibility <plugin-dir> --target <version> [options]',
  '',
  'Options',
  '  --from <version>              current DSH version (printed in the report)',
  '  --to <version>                target DSH version (analysis mode, required)',
  '  --installed <dir>             profile directory whose dsh.profile.bundles are checked',
  '  --matrix <dir>                matrix cells directory or public artifact (default: ./matrix/cells)',
  '  --composition <mode>          exact composition to use: headless or web',
  '  --check-compatibility <dir>   plugin directory to check against --target',
  '  --target <version>            target DSH version for --check-compatibility',
  '  --json                        print only the JSON report on stdout',
  '  --auto-fix                    print, but never execute, an npm install command',
  '  -h, --help                    show this message',
  '',
  'Exit codes',
  '  analysis: 0 no action needed · 1 update/no compatible version · 2 run failed',
  '  check:   0 compatible · 1 incompatible · 2 unknown/no declaration',
  '',
  'Only recent, verified, active evidence for the exact version, DSH, and composition',
  'can produce an upgrade recommendation. Legacy, self-reported, mixed, or unknown',
  'evidence is never upgraded to a safe conclusion.',
].join('\n');

function die(message) {
  console.error('dsh-plugin-upgrade-plan: ' + message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false, autoFix: false, help: false };
  const valueFlags = {
    '--from': 'from',
    '--to': 'to',
    '--installed': 'installed',
    '--check-compatibility': 'checkCompatibility',
    '--target': 'target',
    '--matrix': 'matrix',
    '--composition': 'composition',
  };
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inline;
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 2) {
      inline = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    }
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--auto-fix') { options.autoFix = true; continue; }
    if (Object.hasOwn(valueFlags, arg)) {
      const value = inline !== undefined ? inline : argv[++index];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) die(arg + ' needs a value');
      options[valueFlags[arg]] = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') die('unknown option: ' + arg);
    die('unexpected argument: ' + arg);
  }
  return options;
}

function printAnalysis(report, options) {
  const { summary, categories } = report;
  console.log('\nDSH Upgrade Impact Analysis (experimental)');
  console.log(`   ${report.from} → ${report.to} · composition: ${report.composition || 'unknown'}\n`);
  console.log(`Profile: ${report.profile.path} (${summary.total} plugin(s), source: ${report.profile.source})`);
  console.log(`Matrix:  ${report.matrix.dir} (${report.matrix.cells} cell(s), DSH versions: ${report.matrix.dshVersions.join(', ')})\n`);
  console.log('='.repeat(70));
  console.log('UPGRADE COMPATIBILITY REPORT');
  console.log('='.repeat(70) + '\n');
  if (summary.total === 0) console.log('No DSH plugins found in this profile; there is nothing to plan.\n');
  for (const plugin of categories.compatible) console.log(`✅ ${plugin.name}@${plugin.version}: verified active on ${report.to}`);
  for (const plugin of categories.untested) console.log(`❔ ${plugin.name}@${plugin.version}: ${plugin.reason}`);
  for (const plugin of categories.mixed) console.log(`❔ ${plugin.name}@${plugin.version}: ${plugin.reason}`);
  for (const plugin of categories.needsUpdate) {
    console.log(`⚠️  ${plugin.name}: ${plugin.version} → ${plugin.recommendedVersion} (verified active on ${report.to})`);
  }
  if (options.autoFix && report.installCommand) console.log(`🔧 Auto-fix command:\n\n   ${report.installCommand}\n`);
  for (const plugin of categories.noCompatibleVersion) {
    console.log(`❌ ${plugin.name}@${plugin.version}: no compatible tested version (tested: ${plugin.testedVersions.join(', ')})`);
  }
  for (const plugin of categories.unknown) console.log(`❓ ${plugin.name}${plugin.version ? '@' + plugin.version : ''}: ${plugin.reason}`);
  for (const plugin of categories.firstParty) console.log(`🛡️  ${plugin.name}@${plugin.version}: first-party, not covered by the community matrix`);
  console.log('\n📈 Summary:');
  console.log(`   Community plugins: ${summary.community}/${summary.total}`);
  console.log(`   Compatible: ${summary.compatible} · Need action: ${summary.needAction} · Unknown: ${summary.unknown} · Mixed: ${summary.mixed} · Untested: ${summary.untested}`);
  console.log(`   First-party: ${summary.firstParty}\n`);
}

function runCheckCompatibility(options) {
  const dir = options.checkCompatibility;
  let pkg;
  try { pkg = loadPackage(dir); } catch (error) { die('cannot load plugin ' + JSON.stringify(dir) + ': ' + error.message); }
  const manifest = pkg.manifest || {};
  const declared = manifest.dsh?.compatibility?.dshReleases;
  const declaredRecord = declared !== null && typeof declared === 'object' && !Array.isArray(declared) ? declared : undefined;
  const targetVersion = options.target;
  let status;
  let declaredStatus;
  let reason;
  if (declaredRecord === undefined || Object.keys(declaredRecord).length === 0) {
    status = 'unknown';
    reason = 'the plugin does not declare dsh.compatibility.dshReleases';
  } else if (!Object.hasOwn(declaredRecord, targetVersion)) {
    status = 'unknown';
    reason = 'the plugin does not declare compatibility with DSH ' + targetVersion + ' (declares: ' + Object.keys(declaredRecord).join(', ') + ')';
  } else {
    declaredStatus = declaredRecord[targetVersion];
    const classification = classifyCompatibilityDeclaration(declaredStatus);
    status = classification;
    reason = classification === 'unknown'
      ? 'the compatibility declaration for DSH ' + targetVersion + ' is pending or unrecognized'
      : 'the plugin declares ' + classification + ' with DSH ' + targetVersion;
  }
  const payload = {
    mode: 'check-compatibility',
    plugin: { name: manifest.name, version: manifest.version, path: dir },
    dshVersion: targetVersion,
    status,
    declaredStatus: declaredStatus ?? null,
    declared: declaredRecord ?? null,
    reason,
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`\nChecking ${manifest.name || dir}@${manifest.version || 'unknown'} with DSH ${targetVersion}\n`);
    console.log(reason);
    if (declaredStatus !== undefined) console.log('   Status: ' + (typeof declaredStatus === 'string' ? declaredStatus : JSON.stringify(declaredStatus)));
    console.log('\nExit codes: 0 compatible · 1 incompatible · 2 unknown/no data.\n');
  }
  process.exit(status === 'compatible' ? 0 : status === 'incompatible' ? 1 : 2);
}

async function runAnalysis(options) {
  if (options.from === undefined || options.to === undefined) die('analysis mode needs --from <version> and --to <version> (or use --check-compatibility)');
  if (options.installed === undefined) die('analysis mode needs --installed <profile-dir>; the matrix alone cannot name installed plugins');
  if (options.composition !== undefined && !['headless', 'web'].includes(options.composition)) die('--composition must be headless or web');
  const matrixDir = options.matrix || join(process.cwd(), 'matrix', 'cells');
  try {
    const report = await planUpgrade({ profileDir: options.installed, matrixDir, from: options.from, to: options.to, composition: options.composition });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printAnalysis(report, options);
    process.exit(report.summary.needAction > 0 ? 1 : 0);
  } catch (error) {
    die(error.message);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const checkMode = options.checkCompatibility !== undefined || options.target !== undefined;
const analysisMode = options.from !== undefined || options.to !== undefined || options.installed !== undefined;
if (checkMode && analysisMode) die('choose one mode: analysis (--from/--to/--installed) or --check-compatibility/--target');
if (options.matrix !== undefined && !existsSync(options.matrix)) die('matrix directory not found: ' + options.matrix);
if (checkMode) {
  if (options.checkCompatibility === undefined) die('--target needs --check-compatibility <plugin-dir>');
  if (options.target === undefined) die('--check-compatibility needs --target <version>');
  runCheckCompatibility(options);
} else if (analysisMode) {
  await runAnalysis(options);
} else {
  die('missing arguments; run with --help for usage');
}
