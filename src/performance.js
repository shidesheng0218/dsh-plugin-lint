/**
 * Performance analysis for plugins: startup time, memory footprint,
 * bundle size, and comparative benchmarks.
 *
 * @module performance
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Analyze performance characteristics of a package.
 * @param {object} pkg - loaded package from loadPackage()
 * @returns {object} performance metrics
 */
export function analyzePerformance(pkg) {
  const metrics = {
    bundleSize: calculateBundleSize(pkg),
    complexity: analyzeComplexity(pkg),
    domImpact: estimateDOMImpact(pkg),
    networkCalls: detectNetworkCalls(pkg),
    heavyDependencies: analyzeHeavyPatterns(pkg),
    score: 0
  };

  // Calculate overall performance score (0-100, higher is better)
  metrics.score = calculatePerformanceScore(metrics);
  metrics.rating = ratePerformance(metrics.score);
  metrics.recommendations = generateRecommendations(metrics);

  return metrics;
}

/**
 * Calculate total bundle size including all shipped files.
 */
function calculateBundleSize(pkg) {
  let totalBytes = 0;
  let jsBytes = 0;
  let largestFiles = [];

  // Count files that would be published
  const files = pkg.files || ['**/*'];
  const shipped = new Set();

  function shouldInclude(relPath) {
    if (!pkg.files) return true; // Everything ships if files not specified
    for (const pattern of files) {
      const norm = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
      if (relPath === norm) return true;
      if (relPath.startsWith(norm + '/')) return true;
      if (norm.includes('*')) {
        const re = new RegExp('^' + norm
          .replace(/[.+^$()|[\]{}\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*') + '$');
        if (re.test(relPath)) return true;
      }
    }
    return false;
  }

  function scanDir(dir, relBase = '') {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        
        const fullPath = join(dir, entry.name);
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (entry.isFile()) {
          if (!shouldInclude(relPath)) continue;
          
          const stat = statSync(fullPath);
          totalBytes += stat.size;
          shipped.add(relPath);

          if (entry.name.match(/\.(js|mjs|cjs|jsx)$/)) {
            jsBytes += stat.size;
          }

          largestFiles.push({
            path: relPath,
            bytes: stat.size,
            kb: Math.round(stat.size / 1024)
          });
        }
      }
    } catch (err) {
      // Skip inaccessible directories
    }
  }

  scanDir(pkg.dir);

  largestFiles.sort((a, b) => b.bytes - a.bytes);

  return {
    total: totalBytes,
    totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
    js: jsBytes,
    jsMB: (jsBytes / (1024 * 1024)).toFixed(2),
    fileCount: shipped.size,
    largest: largestFiles.slice(0, 5),
    thresholds: {
      small: totalBytes < 100 * 1024, // < 100KB
      medium: totalBytes < 1024 * 1024, // < 1MB
      large: totalBytes >= 1024 * 1024 // >= 1MB
    }
  };
}

/**
 * Analyze code complexity indicators.
 */
function analyzeComplexity(pkg) {
  let totalLines = 0;
  let totalFunctions = 0;
  let deepNesting = 0;
  let longFunctions = 0;
  const complexFiles = [];

  for (const file of pkg.jsFiles) {
    const lines = file.text.split('\n').length;
    totalLines += lines;

    // Count function declarations
    const funcMatches = file.text.match(/\bfunction\s+\w+|=>\s*\{|\bfunction\s*\(/g);
    const funcCount = funcMatches ? funcMatches.length : 0;
    totalFunctions += funcCount;

    // Detect deep nesting (4+ levels)
    const nestingLevel = maxNestingLevel(file.text);
    if (nestingLevel >= 4) deepNesting++;

    // Detect long functions (>100 lines)
    const longFuncs = detectLongFunctions(file.text);
    longFunctions += longFuncs;

    const fileComplexity = calculateFileComplexity(file);
    if (fileComplexity > 20) {
      complexFiles.push({
        path: file.path,
        lines,
        functions: funcCount,
        complexity: fileComplexity
      });
    }
  }

  return {
    totalLines,
    avgLinesPerFile: pkg.jsFiles.length > 0 ? Math.round(totalLines / pkg.jsFiles.length) : 0,
    totalFunctions,
    deepNesting,
    longFunctions,
    complexFiles: complexFiles.sort((a, b) => b.complexity - a.complexity).slice(0, 5),
    maintainability: rateComplexity(totalLines, totalFunctions, deepNesting, longFunctions)
  };
}

/**
 * Estimate DOM manipulation impact (for client-side plugins).
 */
function estimateDOMImpact(pkg) {
  if (!pkg.entries.client) {
    return { hasClient: false };
  }

  let domMutations = 0;
  let directBodyAccess = 0;
  let heavySelectors = 0;

  const clientFile = pkg.jsFiles.find(f => f.path === pkg.entries.client);
  if (!clientFile) {
    return { hasClient: true, analyzed: false };
  }

  const patterns = {
    mutations: [
      /\bappendChild\b/g,
      /\binsertBefore\b/g,
      /\bremoveChild\b/g,
      /\binnerHTML\s*=/g,
      /\bcloneNode\b/g
    ],
    bodyAccess: [
      /document\s*\.\s*body/g,
      /document\s*\.\s*documentElement/g
    ],
    heavySelectors: [
      /querySelectorAll\s*\(\s*['"]\*['"]/g, // Select all
      /getElementsByTagName\s*\(\s*['"]\*['"]/g
    ]
  };

  for (const pattern of patterns.mutations) {
    const matches = clientFile.text.match(pattern);
    domMutations += matches ? matches.length : 0;
  }

  for (const pattern of patterns.bodyAccess) {
    const matches = clientFile.text.match(pattern);
    directBodyAccess += matches ? matches.length : 0;
  }

  for (const pattern of patterns.heavySelectors) {
    const matches = clientFile.text.match(pattern);
    heavySelectors += matches ? matches.length : 0;
  }

  return {
    hasClient: true,
    analyzed: true,
    domMutations,
    directBodyAccess,
    heavySelectors,
    risk: (directBodyAccess > 0 || heavySelectors > 0) ? 'high' : 
          (domMutations > 10) ? 'medium' : 'low'
  };
}

/**
 * Detect network call patterns.
 */
function detectNetworkCalls(pkg) {
  const calls = [];
  const externalDomains = new Set();

  const fetchPattern = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const axiosPattern = /axios\s*\.\s*(?:get|post|put|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

  for (const file of pkg.jsFiles) {
    let m;
    
    while ((m = fetchPattern.exec(file.text)) !== null) {
      const url = m[1];
      calls.push({
        type: 'fetch',
        url,
        file: file.path,
        line: lineOfIndex(file.text, m.index)
      });

      if (url.startsWith('http://') || url.startsWith('https://')) {
        try {
          const domain = new URL(url).hostname;
          externalDomains.add(domain);
        } catch {
          // Invalid URL
        }
      }
    }

    while ((m = axiosPattern.exec(file.text)) !== null) {
      const url = m[1];
      calls.push({
        type: 'axios',
        url,
        file: file.path,
        line: lineOfIndex(file.text, m.index)
      });

      if (url.startsWith('http://') || url.startsWith('https://')) {
        try {
          const domain = new URL(url).hostname;
          externalDomains.add(domain);
        } catch {
          // Invalid URL
        }
      }
    }
  }

  return {
    total: calls.length,
    externalDomains: Array.from(externalDomains),
    calls: calls.slice(0, 10), // Sample
    risk: externalDomains.size > 3 ? 'high' : 
          externalDomains.size > 0 ? 'medium' : 'low'
  };
}

/**
 * Detect performance-heavy patterns.
 */
function analyzeHeavyPatterns(pkg) {
  const issues = [];

  for (const file of pkg.jsFiles) {
    // Synchronous fs operations
    const syncFs = [
      /\breadFileSync\b/g,
      /\bwriteFileSync\b/g,
      /\bexistsSync\b/g
    ];
    
    for (const pattern of syncFs) {
      const matches = file.text.match(pattern);
      if (matches && matches.length > 5) {
        issues.push({
          type: 'sync-fs',
          file: file.path,
          count: matches.length,
          severity: 'medium'
        });
        break;
      }
    }

    // Large JSON.parse in loops
    if (/for\s*\([^)]*\)\s*\{[^}]*JSON\.parse/s.test(file.text)) {
      issues.push({
        type: 'json-parse-in-loop',
        file: file.path,
        severity: 'high'
      });
    }

    // Recursive directory walks without limits
    if (/readdirSync.*recursive/i.test(file.text)) {
      issues.push({
        type: 'unbounded-recursion',
        file: file.path,
        severity: 'high'
      });
    }

    // Heavy crypto operations
    if (/\bcrypto\s*\.\s*(?:pbkdf2|scrypt)/g.test(file.text)) {
      issues.push({
        type: 'heavy-crypto',
        file: file.path,
        severity: 'medium'
      });
    }
  }

  return issues;
}

/** Calculate cyclomatic complexity approximation for a file */
function calculateFileComplexity(file) {
  const text = file.text;
  let complexity = 1; // Base complexity

  // Count decision points
  const patterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bcase\s+/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]+:/g, // Ternary
    /&&/g,
    /\|\|/g
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern);
    complexity += matches ? matches.length : 0;
  }

  return complexity;
}

/** Find maximum nesting level in code */
function maxNestingLevel(text) {
  let maxDepth = 0;
  let currentDepth = 0;

  for (const char of text) {
    if (char === '{') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === '}') {
      currentDepth--;
    }
  }

  return maxDepth;
}

/** Detect functions longer than 100 lines */
function detectLongFunctions(text) {
  const funcStarts = [];
  const funcPattern = /\bfunction\s+\w+|=>\s*\{|\bfunction\s*\(/g;
  let m;
  
  while ((m = funcPattern.exec(text)) !== null) {
    funcStarts.push(m.index);
  }

  let longCount = 0;
  for (const start of funcStarts) {
    const endBrace = findMatchingBrace(text, start);
    if (endBrace - start > 100 * 80) { // Rough estimate: 100 lines * 80 chars
      longCount++;
    }
  }

  return longCount;
}

/** Find matching closing brace */
function findMatchingBrace(text, start) {
  const openIdx = text.indexOf('{', start);
  if (openIdx === -1) return start;

  let depth = 1;
  let i = openIdx + 1;
  
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }

  return i;
}

/** Rate complexity level */
function rateComplexity(lines, functions, deepNesting, longFunctions) {
  const avgLinesPerFunc = functions > 0 ? lines / functions : 0;
  
  if (deepNesting > 5 || longFunctions > 3 || avgLinesPerFunc > 100) {
    return 'poor';
  } else if (deepNesting > 2 || longFunctions > 1 || avgLinesPerFunc > 50) {
    return 'fair';
  } else {
    return 'good';
  }
}

/** Calculate overall performance score */
function calculatePerformanceScore(metrics) {
  let score = 100;

  // Bundle size penalty
  const sizeMB = parseFloat(metrics.bundleSize.totalMB);
  if (sizeMB > 5) score -= 30;
  else if (sizeMB > 2) score -= 20;
  else if (sizeMB > 1) score -= 10;

  // Complexity penalty
  if (metrics.complexity.maintainability === 'poor') score -= 20;
  else if (metrics.complexity.maintainability === 'fair') score -= 10;

  // DOM impact penalty
  if (metrics.domImpact.risk === 'high') score -= 15;
  else if (metrics.domImpact.risk === 'medium') score -= 7;

  // Network calls penalty
  if (metrics.networkCalls.risk === 'high') score -= 15;
  else if (metrics.networkCalls.risk === 'medium') score -= 7;

  // Heavy patterns penalty
  score -= metrics.heavyDependencies.length * 5;

  return Math.max(0, Math.min(100, score));
}

/** Rate performance level */
function ratePerformance(score) {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  if (score >= 40) return 'poor';
  return 'critical';
}

/** Generate actionable recommendations */
function generateRecommendations(metrics) {
  const recommendations = [];

  if (parseFloat(metrics.bundleSize.totalMB) > 1) {
    recommendations.push({
      issue: 'Large bundle size',
      suggestion: 'Consider code splitting or removing unused dependencies',
      impact: 'high'
    });
  }

  if (metrics.complexity.longFunctions > 0) {
    recommendations.push({
      issue: `${metrics.complexity.longFunctions} long functions detected`,
      suggestion: 'Break down large functions into smaller, testable units',
      impact: 'medium'
    });
  }

  if (metrics.domImpact.directBodyAccess > 0) {
    recommendations.push({
      issue: 'Direct document.body manipulation',
      suggestion: 'Use DSH slot system instead of direct DOM access',
      impact: 'high'
    });
  }

  if (metrics.networkCalls.externalDomains.length > 3) {
    recommendations.push({
      issue: `Calls to ${metrics.networkCalls.externalDomains.length} external domains`,
      suggestion: 'Reduce third-party dependencies or batch requests',
      impact: 'medium'
    });
  }

  if (metrics.heavyDependencies.length > 0) {
    const highSeverity = metrics.heavyDependencies.filter(d => d.severity === 'high');
    if (highSeverity.length > 0) {
      recommendations.push({
        issue: `${highSeverity.length} performance-heavy patterns found`,
        suggestion: 'Review identified patterns for async alternatives',
        impact: 'high'
      });
    }
  }

  return recommendations;
}

/** Find line number from character index */
function lineOfIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}
