#!/usr/bin/env node
/**
 * Example: Comprehensive plugin analysis workflow
 * 
 * This script demonstrates how to use all the analysis features together
 * to get a complete picture of plugin quality.
 */

import {
  loadPackage,
  lintPackage,
  detectConflicts,
  analyzePerformance,
  analyzeSecurityDeep
} from '../src/index.js';

const pluginPath = process.argv[2];

if (!pluginPath) {
  console.error('Usage: node example.mjs <plugin-directory>');
  process.exit(1);
}

console.log('\n🔍 Comprehensive Plugin Analysis\n');
console.log(`Plugin: ${pluginPath}\n`);
console.log('='.repeat(70));

// 1. Load the package
console.log('\n📦 Loading package...\n');
const pkg = loadPackage(pluginPath);
console.log(`  Name: ${pkg.manifest.name}`);
console.log(`  Version: ${pkg.manifest.version}`);
console.log(`  Files: ${pkg.jsFiles.length} JavaScript files`);

// 2. Run static lint checks
console.log('\n\n' + '='.repeat(70));
console.log('📋 STATIC CONFORMANCE CHECKS');
console.log('='.repeat(70) + '\n');

const lintResults = lintPackage(pluginPath);
console.log(`  Total findings: ${lintResults.findings.length}`);
console.log(`    Errors: ${lintResults.findings.filter(f => f.level === 'error').length}`);
console.log(`    Warnings: ${lintResults.findings.filter(f => f.level === 'warn').length}`);
console.log(`    Info: ${lintResults.findings.filter(f => f.level === 'info').length}`);

if (lintResults.findings.length > 0) {
  console.log('\n  Top 3 findings:');
  for (const finding of lintResults.findings.slice(0, 3)) {
    console.log(`    [${finding.level}] ${finding.rule}: ${finding.message}`);
  }
}

// 3. Performance analysis
console.log('\n\n' + '='.repeat(70));
console.log('⚡ PERFORMANCE ANALYSIS');
console.log('='.repeat(70) + '\n');

const perf = analyzePerformance(pkg);
console.log(`  Overall Score: ${perf.score}/100 (${perf.rating})`);
console.log(`\n  Bundle Size: ${perf.bundleSize.totalMB} MB`);
console.log(`    JavaScript: ${perf.bundleSize.jsMB} MB`);
console.log(`    Total files: ${perf.bundleSize.fileCount}`);

if (perf.bundleSize.largestFiles?.length > 0) {
  console.log(`\n  Largest files:`);
  for (const file of perf.bundleSize.largestFiles.slice(0, 3)) {
    console.log(`    - ${file.path}: ${file.sizeKB} KB`);
  }
}

console.log(`\n  Code Complexity:`);
console.log(`    Total lines: ${perf.complexity.totalLines}`);
console.log(`    Total functions: ${perf.complexity.totalFunctions}`);
console.log(`    Deep nesting: ${perf.complexity.deepNesting} file(s)`);

if (perf.networkCalls.total > 0) {
  console.log(`\n  Network Activity:`);
  console.log(`    Total calls: ${perf.networkCalls.total}`);
  console.log(`    External domains: ${perf.networkCalls.externalDomains.length}`);
  if (perf.networkCalls.externalDomains.length > 0) {
    console.log(`    Domains: ${perf.networkCalls.externalDomains.slice(0, 3).join(', ')}`);
  }
}

if (perf.recommendations.length > 0) {
  console.log(`\n  Recommendations (${perf.recommendations.length}):`);
  for (const rec of perf.recommendations.slice(0, 3)) {
    console.log(`    ${rec.impact === 'high' ? '🔴' : rec.impact === 'medium' ? '🟡' : '🟢'} ${rec.issue}`);
  }
}

// 4. Security analysis
console.log('\n\n' + '='.repeat(70));
console.log('🔒 SECURITY DEEP ANALYSIS');
console.log('='.repeat(70) + '\n');

const security = analyzeSecurityDeep(pkg);
console.log(`  Risk Level: ${security.riskLevel}`);
console.log(`\n  Findings: ${security.summary.total}`);
console.log(`    Errors: ${security.summary.error}`);
console.log(`    Warnings: ${security.summary.warn}`);
console.log(`    Info: ${security.summary.info}`);

if (security.findings.length > 0) {
  console.log(`\n  By Category:`);
  for (const [category, findings] of Object.entries(security.byCategory)) {
    console.log(`    ${category}: ${findings.length} finding(s)`);
  }

  console.log(`\n  Top security findings:`);
  const criticalFindings = security.findings
    .filter(f => f.level === 'error')
    .slice(0, 3);
  
  if (criticalFindings.length > 0) {
    for (const finding of criticalFindings) {
      console.log(`    [${finding.level}] ${finding.title}`);
      console.log(`      ${finding.file}:${finding.line}`);
      console.log(`      ${finding.message}`);
    }
  } else {
    console.log(`    No critical security issues found`);
  }
}

// 5. Generate overall health score
console.log('\n\n' + '='.repeat(70));
console.log('📊 OVERALL PLUGIN HEALTH');
console.log('='.repeat(70) + '\n');

// Calculate weighted health score
const scores = {
  conformance: 100 - (lintResults.findings.filter(f => f.level === 'error').length * 10),
  performance: perf.score,
  security: {
    'minimal': 100,
    'low': 85,
    'medium': 70,
    'high': 50,
    'critical': 20
  }[security.riskLevel] || 50
};

const overallScore = Math.round(
  (scores.conformance * 0.3) + 
  (scores.performance * 0.4) + 
  (scores.security * 0.3)
);

console.log(`  Conformance: ${Math.max(0, scores.conformance)}/100`);
console.log(`  Performance: ${scores.performance}/100`);
console.log(`  Security:    ${scores.security}/100`);
console.log(`\n  Overall:     ${Math.max(0, Math.min(100, overallScore))}/100`);

// Rating
let rating, emoji;
if (overallScore >= 90) {
  rating = 'Excellent';
  emoji = '🟢';
} else if (overallScore >= 75) {
  rating = 'Good';
  emoji = '🟡';
} else if (overallScore >= 60) {
  rating = 'Fair';
  emoji = '🟠';
} else {
  rating = 'Needs Improvement';
  emoji = '🔴';
}

console.log(`\n  ${emoji} Rating: ${rating}`);

// Summary and recommendations
console.log('\n\n' + '='.repeat(70));
console.log('💡 SUMMARY & RECOMMENDATIONS');
console.log('='.repeat(70) + '\n');

const issues = [];

if (lintResults.findings.filter(f => f.level === 'error').length > 0) {
  issues.push('Fix conformance errors to ensure compatibility');
}

if (perf.score < 70) {
  issues.push('Improve performance - consider reducing bundle size or complexity');
}

if (security.summary.error > 0) {
  issues.push('Address critical security issues immediately');
}

if (security.riskLevel === 'high' || security.riskLevel === 'critical') {
  issues.push('Security risk is elevated - review all external network calls and data handling');
}

if (!pkg.manifest.dsh?.compatibility?.dshReleases) {
  issues.push('Add dsh.compatibility.dshReleases to manifest for better upgrade safety');
}

if (issues.length === 0) {
  console.log('  ✅ No major issues detected. This plugin appears well-maintained.\n');
} else {
  console.log('  Priority actions:\n');
  issues.forEach((issue, i) => {
    console.log(`    ${i + 1}. ${issue}`);
  });
  console.log();
}

// Export data option
if (process.argv.includes('--json')) {
  const report = {
    plugin: {
      name: pkg.manifest.name,
      version: pkg.manifest.version
    },
    timestamp: new Date().toISOString(),
    scores,
    overallScore,
    rating,
    conformance: {
      total: lintResults.findings.length,
      errors: lintResults.findings.filter(f => f.level === 'error').length,
      warnings: lintResults.findings.filter(f => f.level === 'warn').length
    },
    performance: {
      score: perf.score,
      rating: perf.rating,
      bundleSizeMB: perf.bundleSize.totalMB
    },
    security: {
      riskLevel: security.riskLevel,
      total: security.summary.total,
      errors: security.summary.error
    },
    recommendations: issues
  };

  console.log('\n\n' + '='.repeat(70));
  console.log('JSON REPORT');
  console.log('='.repeat(70) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

console.log('\n' + '='.repeat(70));
console.log('Analysis complete');
console.log('='.repeat(70) + '\n');
