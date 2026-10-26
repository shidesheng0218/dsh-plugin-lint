#!/usr/bin/env node
/**
 * CLI for composition conflict detection and performance analysis.
 * 
 * Usage:
 *   dsh-plugin-analyze conflicts <dir1> <dir2> ...
 *   dsh-plugin-analyze performance <dir>
 *   dsh-plugin-analyze full <dir>  (runs both)
 */

import { readFileSync } from 'node:fs';
import { loadPackage } from '../src/load.js';
import { detectConflicts } from '../src/composition.js';
import { analyzePerformance } from '../src/performance.js';
import { analyzeSecurityDeep } from '../src/security.js';

const args = process.argv.slice(2);
const command = args[0];
const targets = args.slice(1);

if (!command || targets.length === 0) {
  console.error(`
Usage:
  dsh-plugin-analyze conflicts <dir1> <dir2> ...    Detect composition conflicts
  dsh-plugin-analyze performance <dir>              Analyze performance metrics
  dsh-plugin-analyze security <dir>                 Analyze security patterns
  dsh-plugin-analyze full <dir>                     Run all analyses on single plugin

Examples:
  dsh-plugin-analyze conflicts ./plugin-a ./plugin-b ./plugin-c
  dsh-plugin-analyze performance ./my-plugin
  dsh-plugin-analyze full ./my-plugin
`);
  process.exit(1);
}

async function runConflictAnalysis(dirs) {
  console.log(`\n🔍 Analyzing ${dirs.length} plugin(s) for composition conflicts...\n`);

  const packages = [];
  for (const dir of dirs) {
    try {
      const pkg = loadPackage(dir);
      packages.push({
        name: pkg.manifest.name || dir,
        manifest: pkg.manifest,
        jsFiles: pkg.jsFiles,
        entries: pkg.entries
      });
      console.log(`  ✓ Loaded ${pkg.manifest.name || dir}`);
    } catch (err) {
      console.error(`  ✗ Failed to load ${dir}: ${err.message}`);
    }
  }

  if (packages.length < 2) {
    console.log(`\n⚠️  Need at least 2 plugins to detect conflicts (loaded ${packages.length})`);
    return;
  }

  const conflicts = detectConflicts(packages);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`COMPOSITION CONFLICT REPORT`);
  console.log(`${'='.repeat(70)}\n`);

  console.log(`Summary: ${conflicts.summary.total} conflict(s) found`);
  console.log(`  🔴 High risk:   ${conflicts.summary.high}`);
  console.log(`  🟡 Medium risk: ${conflicts.summary.medium}`);
  console.log(`  🟢 Low risk:    ${conflicts.summary.low}\n`);

  if (conflicts.summary.total === 0) {
    console.log('✅ No conflicts detected!\n');
    return;
  }

  // UI Slot Collisions
  if (conflicts.slots.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`UI SLOT COLLISIONS (${conflicts.slots.length})`);
    console.log(`${'─'.repeat(70)}`);
    for (const c of conflicts.slots) {
      const riskIcon = c.risk === 'high' ? '🔴' : c.risk === 'medium' ? '🟡' : '🟢';
      console.log(`\n${riskIcon} Slot: ${c.resource}`);
      console.log(`  Plugins: ${c.plugins.join(', ')}`);
      console.log(`  Risk: ${c.risk}`);
      console.log(`  Resolution: ${c.resolution}`);
    }
  }

  // Tool Name Duplicates
  if (conflicts.toolNames.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`TOOL NAME COLLISIONS (${conflicts.toolNames.length})`);
    console.log(`${'─'.repeat(70)}`);
    for (const c of conflicts.toolNames) {
      console.log(`\n🔴 Tool: ${c.resource}`);
      console.log(`  Plugins: ${c.plugins.join(', ')}`);
      console.log(`  Resolution: ${c.resolution}`);
    }
  }

  // Route Conflicts
  if (conflicts.routes.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`ROUTE CONFLICTS (${conflicts.routes.length})`);
    console.log(`${'─'.repeat(70)}`);
    for (const c of conflicts.routes) {
      console.log(`\n🟡 Route: ${c.resource}`);
      console.log(`  Plugins: ${c.plugins.join(', ')}`);
      console.log(`  Resolution: ${c.resolution}`);
    }
  }

  // Config Key Overwrites
  if (conflicts.configKeys.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`CONFIG KEY CONFLICTS (${conflicts.configKeys.length})`);
    console.log(`${'─'.repeat(70)}`);
    for (const c of conflicts.configKeys) {
      const riskIcon = c.risk === 'high' ? '🔴' : c.risk === 'medium' ? '🟡' : '🟢';
      console.log(`\n${riskIcon} Key: ${c.resource}`);
      console.log(`  Plugins: ${c.plugins.join(', ')}`);
      console.log(`  Risk: ${c.risk}`);
      console.log(`  Resolution: ${c.resolution}`);
    }
  }

  // Waterfall Listener Issues
  if (conflicts.eventListeners.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`WATERFALL LISTENER ISSUES (${conflicts.eventListeners.length})`);
    console.log(`${'─'.repeat(70)}`);
    for (const c of conflicts.eventListeners) {
      console.log(`\n🔴 Event: ${c.resource}`);
      console.log(`  All listeners: ${c.plugins.join(', ')}`);
      console.log(`  Problematic: ${c.problematic.join(', ')}`);
      console.log(`  Resolution: ${c.resolution}`);
    }
  }

  console.log(`\n${'='.repeat(70)}\n`);
}

async function runPerformanceAnalysis(dir) {
  console.log(`\n⚡ Analyzing performance: ${dir}\n`);

  let pkg;
  try {
    pkg = loadPackage(dir);
  } catch (err) {
    console.error(`✗ Failed to load package: ${err.message}`);
    process.exit(1);
  }

  const metrics = analyzePerformance(pkg);

  console.log(`${'='.repeat(70)}`);
  console.log(`PERFORMANCE REPORT: ${pkg.manifest.name || dir}`);
  console.log(`${'='.repeat(70)}\n`);

  // Overall Score
  const scoreIcon = metrics.score >= 90 ? '🟢' :
                    metrics.score >= 75 ? '🟡' :
                    metrics.score >= 60 ? '🟠' : '🔴';
  console.log(`${scoreIcon} Overall Score: ${metrics.score}/100 (${metrics.rating})\n`);

  // Bundle Size
  console.log(`${'─'.repeat(70)}`);
  console.log(`BUNDLE SIZE`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Total: ${metrics.bundleSize.totalMB} MB (${metrics.bundleSize.fileCount} files)`);
  console.log(`  JavaScript: ${metrics.bundleSize.jsMB} MB`);
  
  if (metrics.bundleSize.largest.length > 0) {
    console.log(`\n  Largest files:`);
    for (const file of metrics.bundleSize.largest) {
      console.log(`    - ${file.path}: ${file.kb} KB`);
    }
  }

  // Complexity
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`CODE COMPLEXITY`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Total lines: ${metrics.complexity.totalLines}`);
  console.log(`  Avg lines/file: ${metrics.complexity.avgLinesPerFile}`);
  console.log(`  Total functions: ${metrics.complexity.totalFunctions}`);
  console.log(`  Deep nesting (4+ levels): ${metrics.complexity.deepNesting} file(s)`);
  console.log(`  Long functions (>100 lines): ${metrics.complexity.longFunctions}`);
  console.log(`  Maintainability: ${metrics.complexity.maintainability}`);

  if (metrics.complexity.complexFiles.length > 0) {
    console.log(`\n  Most complex files:`);
    for (const file of metrics.complexity.complexFiles) {
      console.log(`    - ${file.path}: complexity ${file.complexity}, ${file.lines} lines`);
    }
  }

  // DOM Impact
  if (metrics.domImpact.hasClient) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`DOM IMPACT`);
    console.log(`${'─'.repeat(70)}`);
    if (metrics.domImpact.analyzed) {
      const riskIcon = metrics.domImpact.risk === 'high' ? '🔴' :
                       metrics.domImpact.risk === 'medium' ? '🟡' : '🟢';
      console.log(`  ${riskIcon} Risk level: ${metrics.domImpact.risk}`);
      console.log(`  DOM mutations: ${metrics.domImpact.domMutations}`);
      console.log(`  Direct body access: ${metrics.domImpact.directBodyAccess}`);
      console.log(`  Heavy selectors: ${metrics.domImpact.heavySelectors}`);
    } else {
      console.log(`  ⚠️  Client entry declared but not analyzed`);
    }
  }

  // Network Calls
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`NETWORK ACTIVITY`);
  console.log(`${'─'.repeat(70)}`);
  const netRiskIcon = metrics.networkCalls.risk === 'high' ? '🔴' :
                      metrics.networkCalls.risk === 'medium' ? '🟡' : '🟢';
  console.log(`  ${netRiskIcon} Risk level: ${metrics.networkCalls.risk}`);
  console.log(`  Total network calls: ${metrics.networkCalls.total}`);
  console.log(`  External domains: ${metrics.networkCalls.externalDomains.length}`);
  
  if (metrics.networkCalls.externalDomains.length > 0) {
    console.log(`\n  Domains contacted:`);
    for (const domain of metrics.networkCalls.externalDomains) {
      console.log(`    - ${domain}`);
    }
  }

  // Heavy Patterns
  if (metrics.heavyDependencies.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`PERFORMANCE-HEAVY PATTERNS`);
    console.log(`${'─'.repeat(70)}`);
    for (const issue of metrics.heavyDependencies) {
      const icon = issue.severity === 'high' ? '🔴' : '🟡';
      console.log(`  ${icon} ${issue.type} in ${issue.file}`);
    }
  }

  // Recommendations
  if (metrics.recommendations.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`RECOMMENDATIONS`);
    console.log(`${'─'.repeat(70)}`);
    for (const rec of metrics.recommendations) {
      const icon = rec.impact === 'high' ? '🔴' : '🟡';
      console.log(`\n  ${icon} ${rec.issue}`);
      console.log(`     → ${rec.suggestion}`);
    }
  }

  console.log(`\n${'='.repeat(70)}\n`);
}

async function runSecurityAnalysis(dir) {
  const pkg = loadPackage(dir);
  const result = analyzeSecurityDeep(pkg);

  console.log(`\n🔐 Analyzing security: ${pkg.manifest.name}\n`);
  console.log(`${'='.repeat(70)}`);
  console.log(`SECURITY REPORT: ${pkg.manifest.name}`);
  console.log(`${'='.repeat(70)}\n`);
  console.log(`Risk level: ${result.riskLevel}  (${result.summary.warn} warning(s), ${result.summary.info} note(s))\n`);

  if (result.findings.length === 0) {
    console.log('  No findings.\n');
    return result;
  }

  for (const [category, findings] of Object.entries(result.byCategory)) {
    console.log(`  ${category}:`);
    for (const f of findings) {
      console.log(`    [${f.rule} ${f.level}] ${f.title}`);
      console.log(`      ${f.file}:${f.line}  ${f.message}`);
      if (f.evidence) console.log(`      evidence: ${f.evidence}`);
    }
    console.log();
  }
  console.log('  These are heuristic findings, not a security verdict. Each cites the file and line so it can be checked by hand.\n');
  return result;
}

async function runFullAnalysis(dir) {
  await runPerformanceAnalysis(dir);
  await runSecurityAnalysis(dir);

  console.log(`\n💡 Tip: To check for conflicts with other plugins, run:`);
  console.log(`   dsh-plugin-analyze conflicts ${dir} <other-plugin-dir>\n`);
}

// Main execution
switch (command) {
  case 'conflicts':
    await runConflictAnalysis(targets);
    break;
  
  case 'security':
  case 'sec':
    if (targets.length !== 1) {
      console.error('Error: security analysis requires exactly one directory');
      process.exit(1);
    }
    await runSecurityAnalysis(targets[0]);
    break;

  case 'performance':
  case 'perf':
    if (targets.length !== 1) {
      console.error('Error: performance analysis requires exactly one directory');
      process.exit(1);
    }
    await runPerformanceAnalysis(targets[0]);
    break;
  
  case 'full':
  case 'all':
    if (targets.length !== 1) {
      console.error('Error: full analysis requires exactly one directory');
      process.exit(1);
    }
    await runFullAnalysis(targets[0]);
    break;
  
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Valid commands: conflicts, performance, full');
    process.exit(1);
}
