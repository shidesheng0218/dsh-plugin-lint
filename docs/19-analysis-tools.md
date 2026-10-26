# New Features - Extended Analysis

This document describes the new P0 features added to dsh-plugin-lint to make it more useful and necessary for the DSH plugin ecosystem.

## Overview

The project has been extended with three major capabilities:

1. **Composition Conflict Detection** - Find collisions when multiple plugins compete for resources
2. **Performance Analysis** - Identify performance bottlenecks and heavy patterns
3. **Security Deep Analysis** - Detect security risks beyond capability disclosure

## 1. Composition Conflict Detection

### What it does

Detects conflicts across multiple installed plugins that compete for the same resources:

- **UI Slot Collisions**: Multiple plugins trying to render in the same slot
- **Tool Name Duplicates**: Different plugins registering tools with the same name
- **Route Conflicts**: Multiple plugins claiming the same HTTP route
- **Config Key Overwrites**: Plugins fighting for the same configuration keys
- **Waterfall Listener Issues**: Plugins that don't properly return `next()` in event chains

### Usage

```bash
# Check conflicts between plugins
dsh-plugin-analyze conflicts ./plugin-a ./plugin-b ./plugin-c

# Example output:
# 🔍 Analyzing 3 plugin(s) for composition conflicts...
#
# ======================================================================
# COMPOSITION CONFLICT REPORT
# ======================================================================
#
# Summary: 2 conflict(s) found
#   🔴 High risk:   1
#   🟡 Medium risk: 1
#
# ──────────────────────────────────────────────────────────────────────
# UI SLOT COLLISIONS (1)
# ──────────────────────────────────────────────────────────────────────
#
# 🔴 Slot: ui.slot.sidebar
#   Plugins: plugin-a, plugin-b
#   Risk: high
#   Resolution: Consider disabling one of: plugin-a, plugin-b
```

### Why it matters

This fills a **confirmed ecosystem gap**. From the research:
- 786 UI plugins competing for limited slots
- No existing tool detects these conflicts
- Users don't know why their plugins "disappear" or override each other

### API

```javascript
import { detectConflicts, loadPackage } from '@shidesheng0218/dsh-plugin-lint';

const packages = [
  loadPackage('./plugin-a'),
  loadPackage('./plugin-b')
].map(pkg => ({
  name: pkg.manifest.name,
  manifest: pkg.manifest,
  jsFiles: pkg.jsFiles
}));

const conflicts = detectConflicts(packages);
console.log(`Found ${conflicts.summary.total} conflicts`);
console.log(`High risk: ${conflicts.summary.high}`);
```

## 2. Performance Analysis

### What it does

Provides actionable performance metrics:

- **Bundle Size**: Total shipped bytes, JS size, largest files
- **Code Complexity**: Lines, functions, nesting depth, maintainability rating
- **DOM Impact**: Mutations, direct body access, heavy selectors (client plugins)
- **Network Activity**: External calls, domains contacted
- **Performance Score**: 0-100 rating with recommendations

### Usage

```bash
# Analyze single plugin
dsh-plugin-analyze performance ./my-plugin

# Example output:
# ⚡ Analyzing performance: ./my-plugin
#
# ======================================================================
# PERFORMANCE REPORT: my-awesome-plugin
# ======================================================================
#
# 🟡 Overall Score: 72/100 (good)
#
# ──────────────────────────────────────────────────────────────────────
# BUNDLE SIZE
# ──────────────────────────────────────────────────────────────────────
#   Total: 2.3 MB (45 files)
#   JavaScript: 1.8 MB
#
#   Largest files:
#     - dist/bundle.js: 1200 KB
#     - vendor/lib.js: 450 KB
#
# ──────────────────────────────────────────────────────────────────────
# RECOMMENDATIONS
# ──────────────────────────────────────────────────────────────────────
#
#   🔴 Large bundle size
#      → Consider code splitting or removing unused dependencies
#      Impact: high
```

### Why it matters

**Differentiation from existing tools**:
- `dsh-plugin-doctor`: checks package structure
- `dsh-testkit`: tests install/uninstall lifecycle
- **dsh-plugin-lint performance**: analyzes runtime impact

Users can now answer: "Why is my DSH slow after installing this plugin?"

### API

```javascript
import { analyzePerformance, loadPackage } from '@shidesheng0218/dsh-plugin-lint';

const pkg = loadPackage('./my-plugin');
const metrics = analyzePerformance(pkg);

console.log(`Bundle: ${metrics.bundleSize.totalMB} MB`);
console.log(`Score: ${metrics.score}/100 (${metrics.rating})`);
console.log(`Recommendations: ${metrics.recommendations.length}`);
```

## 3. Security Deep Analysis

### What it does

Goes beyond capability disclosure to analyze **how** capabilities are used:

- **Data Exfiltration**: Session/credential data sent to external domains
- **Credential Handling**: Storing tokens in localStorage
- **Code Injection**: eval(), Function(), innerHTML without sanitization
- **Command Injection**: Shell commands built with string interpolation
- **Network Integrity**: Undeclared domains, insecure HTTP
- **File System Access**: Operations outside workspace

### Usage

```bash
dsh-plugin-analyze security ./plugin
```

Findings are heuristic and capped at warning level: an error level is reserved for rules that are mechanically decidable, and these patterns are not. Each finding names the file, the line and the evidence; the report is an aid to review, not a verdict.

The same analysis is available as a library call:
```

```javascript
import { analyzeSecurityDeep, loadPackage } from '@shidesheng0218/dsh-plugin-lint';

const pkg = loadPackage('./plugin');
const result = analyzeSecurityDeep(pkg);

console.log(`Risk level: ${result.riskLevel}`);
console.log(`Findings: ${result.summary.total}`);
console.log(`  Errors: ${result.summary.error}`);
console.log(`  Warnings: ${result.summary.warn}`);

// By category
for (const [category, findings] of Object.entries(result.byCategory)) {
  console.log(`\n${category}: ${findings.length} issue(s)`);
  for (const finding of findings) {
    console.log(`  [${finding.level}] ${finding.message}`);
    console.log(`    ${finding.file}:${finding.line}`);
    console.log(`    Hint: ${finding.hint}`);
  }
}
```

### Why it matters

**Complements dsh-trust-check**:
- `dsh-trust-check`: "This plugin CAN access network" (capability disclosure)
- **Security deep analysis**: "This plugin SENDS session data to analytics.example.com" (behavior audit)

From research: 1,620 plugins declare shell access, 486 declare credential access. **None are audited for how they use these capabilities.**

### Security Rules

| Rule | Level | Detects |
|------|-------|---------|
| S1 | error | Session data sent to external domains |
| S2 | error | Credentials in localStorage/sessionStorage |
| S3 | warn | eval() or Function() constructor |
| S4 | error | innerHTML without sanitization |
| S5 | warn | Network requests to undeclared domains |
| S6 | error | Shell command injection risks |
| S7 | warn | File system operations outside workspace |
| S8 | info | Cryptographic function usage |
| S9 | warn | Excessive process.env access |
| S10 | error | Insecure HTTP in production |

## 4. Upgrade Path Generator

### What it does

Helps users plan DSH version upgrades by checking plugin compatibility:

```bash
# Check upgrade impact
dsh-plugin-upgrade-plan --from 0.2.0-rc.2 --to 0.3.0 --installed ~/.dsh/profiles/default

# Check single plugin
dsh-plugin-upgrade-plan --check-compatibility ./my-plugin --target 0.3.0
```

### Example output

```
📊 DSH Upgrade Impact Analysis
   0.2.0-rc.2 → 0.3.0

Found 15 DSH plugin(s) in ~/.dsh/profiles/default

======================================================================
UPGRADE COMPATIBILITY REPORT
======================================================================

✅ 10 plugin(s) already compatible:
   - plugin-a@1.0.0
   - plugin-b@2.1.0
   ...

⚠️  3 plugin(s) need update:
   - old-plugin: 1.0.0 → 1.2.0
   - legacy-tool: 0.5.0 → 0.8.0
   ...

🔧 Auto-fix command:
   npm install old-plugin@1.2.0 legacy-tool@0.8.0

❌ 2 plugin(s) have no compatible version:
   - abandoned-plugin@1.0.0
     → Consider finding alternative or contact maintainer

📈 Summary:
   Safe to upgrade: 10/15
   Need action: 5/15
```

### Why it matters

Users currently have **no way to know** if their plugins will work after upgrading DSH. This tool:
- Uses compatibility matrix data
- Queries npm for updated versions
- Generates actionable upgrade commands
- Identifies plugins that need replacements

## Integration

### CLI Commands

```bash
# Performance analysis
dsh-plugin-analyze performance ./plugin

# Conflict detection (requires 2+ plugins)
dsh-plugin-analyze conflicts ./plugin-a ./plugin-b

# Full analysis (performance + recommendations)
dsh-plugin-analyze full ./plugin

# Upgrade planning
dsh-plugin-upgrade-plan --from 0.2.0 --to 0.3.0
```

### Programmatic API

All features are exported from the main package:

```javascript
import {
  detectConflicts,
  analyzePerformance,
  analyzeSecurityDeep,
  loadPackage
} from '@shidesheng0218/dsh-plugin-lint';
```

### CI Integration

```yaml
# .github/workflows/plugin-check.yml
- name: Check conflicts with popular plugins
  run: |
    npm install -g @shidesheng0218/dsh-plugin-lint
    
    # Download popular plugins
    npm install dsh-context dsh-whale-widget --prefix /tmp/test-env
    
    # Check for conflicts
    dsh-plugin-analyze conflicts . /tmp/test-env/node_modules/dsh-context

- name: Performance gate
  run: |
    dsh-plugin-analyze performance . --json > perf.json
    
    # Fail if score < 60
    SCORE=$(jq '.score' perf.json)
    if [ "$SCORE" -lt 60 ]; then
      echo "Performance score too low: $SCORE"
      exit 1
    fi
```

## Testing

All new features have comprehensive test coverage:

```bash
npm test

# Or individual test files:
node test/composition.test.js
node test/performance.test.js
node test/security.test.js
```

## Roadmap

These P0 features lay the foundation for:

- **P1**: VSCode/Cursor extension for real-time conflict/performance warnings
- **P1**: Federated compatibility matrix (plugin authors submit their own test results)
- **P2**: AI-powered auto-fix for common issues
- **P2**: Ecosystem health scoring and plugin recommendations

## Impact Metrics

To measure success:

1. **Adoption**: CLI installs, API usage in other tools
2. **Coverage**: % of ecosystem covered by conflict/performance data
3. **Official recognition**: Referenced in DSH docs or bundled with official tools
4. **Market integration**: dshmarket displays scores from this tool

## Contributing

The modular architecture makes it easy to extend:

- Add new conflict patterns to `src/composition.js`
- Add performance metrics to `src/performance.js`
- Add security rules to `src/security.js`

Each module follows the same pattern:
1. Export a primary analysis function
2. Accept a loaded package from `loadPackage()`
3. Return structured findings with evidence

See existing test files for examples.
