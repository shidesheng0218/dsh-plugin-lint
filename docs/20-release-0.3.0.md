# Release Notes - v0.3.0

## New Features: Extended Analysis Capabilities

Version 0.3.0 introduces three major P0 features that make dsh-plugin-lint essential for the DSH plugin ecosystem.

### 1. Composition Conflict Detection 🔍

**Fills confirmed ecosystem gap**: With 786 UI plugins competing for limited slots, users need to know when plugins will collide before installing them.

- Detects UI slot collisions (multiple plugins claiming same slot)
- Identifies tool name duplicates
- Finds route conflicts and config key overwrites
- Checks waterfall event listener chains

```bash
dsh-plugin-analyze conflicts ./plugin-a ./plugin-b ./plugin-c
```

**Why it matters**: Users currently have no way to predict plugin conflicts. This fills a gap confirmed in ecosystem research.

### 2. Performance Analysis ⚡

**Differentiates from existing tools**: While `dsh-testkit` tests lifecycle and `dsh-plugin-doctor` checks structure, this analyzes runtime impact.

- Bundle size breakdown (total, JS, largest files)
- Code complexity metrics (nesting, functions, maintainability)
- DOM impact analysis for UI plugins
- Network activity tracking
- 0-100 performance score with actionable recommendations

```bash
dsh-plugin-analyze performance ./my-plugin
```

**Why it matters**: Users can now answer "Why is my DSH slow after installing this plugin?"

### 3. Security Deep Analysis 🔒

**Complements dsh-trust-check**: Goes beyond capability disclosure to analyze HOW capabilities are used.

10 new security rules detect:
- Data exfiltration (session data sent externally)
- Credential storage in localStorage
- Code injection risks (eval, innerHTML)
- Command injection patterns
- Insecure HTTP usage
- File system operations outside workspace

```javascript
import { analyzeSecurityDeep } from '@shidesheng0218/dsh-plugin-lint';
const result = analyzeSecurityDeep(pkg);
console.log(`Risk: ${result.riskLevel}`); // minimal|low|medium|high|critical
```

**Why it matters**: Research shows 1,620 plugins declare shell access and 486 declare credential access. None are audited for how they use these capabilities.

### 4. Upgrade Path Generator 🔄

Helps users plan DSH version upgrades:

```bash
dsh-plugin-upgrade-plan --from 0.2.0-rc.2 --to 0.3.0 --installed ~/.dsh/profiles/default
```

Provides:
- Compatibility status for all installed plugins
- Recommended version updates
- Auto-generated `npm install` commands
- Identifies plugins needing replacement

**Why it matters**: Users have no way to know if their plugins will work after upgrading DSH.

## New CLI Commands

- `dsh-plugin-analyze performance <dir>` - Performance analysis with recommendations
- `dsh-plugin-analyze conflicts <dir1> <dir2> ...` - Multi-plugin conflict detection
- `dsh-plugin-analyze full <dir>` - Comprehensive analysis report
- `dsh-plugin-upgrade-plan` - Upgrade compatibility checker

## New Programmatic APIs

All features exported from main package:

```javascript
import {
  detectConflicts,
  analyzePerformance,
  analyzeSecurityDeep,
  SECURITY_RULES
} from '@shidesheng0218/dsh-plugin-lint';
```

## Documentation

- [docs/NEW_FEATURES.md](docs/NEW_FEATURES.md) - Detailed feature documentation
- [examples/comprehensive-analysis.mjs](examples/comprehensive-analysis.mjs) - End-to-end workflow example

## Testing

All new features have comprehensive test coverage:
- `test/composition.test.js` - Conflict detection (4 tests)
- `test/performance.test.js` - Performance analysis (4 tests)
- `test/security.test.js` - Security deep analysis (7 tests)

## Breaking Changes

None. All existing APIs remain unchanged. New features are additive.

## Impact Metrics

From ecosystem research (as of 2026-10-13):
- **4,508** catalogued plugins
- **786** UI plugins (slot collision candidates)
- **1,620** plugins with shell access
- **486** plugins with credential access
- **66%** of Top 100 couple to Harness Client packages

These features address gaps that affect thousands of plugins and their users.

## What's Next (Roadmap)

- **P1**: VSCode/Cursor extension for real-time warnings
- **P1**: Federated matrix (plugin authors submit test results)
- **P2**: Ecosystem health scoring and recommendations
- **P2**: AI-powered auto-fix suggestions

## Migration Guide

No migration needed. Upgrade from 0.2.x to 0.3.0 is seamless:

```bash
npm install -g @shidesheng0218/dsh-plugin-lint@latest
```

All existing commands work as before. New commands are opt-in.

## Acknowledgments

Thanks to the DSH community for the ecosystem research data and feedback that shaped these features.

---

See [README.md](README.md) for full documentation and [docs/NEW_FEATURES.md](docs/NEW_FEATURES.md) for detailed feature guides.
