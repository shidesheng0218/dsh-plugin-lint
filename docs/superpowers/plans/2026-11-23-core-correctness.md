# Core Correctness Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six reproduced linter correctness defects without expanding the product surface or adding dependencies.

**Architecture:** Keep the existing synchronous ESM core. Scope issue identity by package, make Git/npm/compression semantics agree with their references, and give packed reports stable logical roots while leaving directory-report behavior unchanged.

**Tech Stack:** Node.js >=22, ESM, `node:test`, `assert/strict`, built-in `node:zlib`, real `npm pack --dry-run` differential fixtures.

**Spec:** `docs/superpowers/specs/2026-11-23-core-correctness-design.md`

## Global Constraints

- Work only in `.claude/worktrees/dsh-core-correctness`; never edit the original dirty checkout.
- Node.js >=22, pure ESM, built-in runtime modules only; do not install dependencies.
- Write each regression test first and observe its expected failure before editing implementation.
- No matrix, probe, panel, upgrade, federation, release-workflow, npm publish, Docker, third-party plugin, or real-profile work. After final review and verification, the user explicitly authorized one commit and push of `worktree-dsh-core-correctness`; do not push `main` or create a PR.
- Preserve baseline schema version 1 and existing directory-report behavior except for the defects specified below.
- Keep every existing tar traversal, link, entry-count, and unpacked-byte rejection.

## Review Focus

- **Legacy identity:** an unscoped baseline works for one package but must reject multiple reports with regeneration guidance; pinned by Tasks 1 and 7.
- **Deletion-only changes:** deleting a manifest-referenced entry still selects its former package and produces E3; pinned by Task 2 for both worktree and staged diffs.
- **Range boundaries and invalid grammar:** partial caret/x-range upper bounds agree with node-semver while mixed invalid forms return `null`; pinned by Task 3.
- **Ignore versus selection:** root `files[]` still disables root ignore while nested basename ignores and negations match npm; pinned by Task 4.
- **Compressed expansion and virtual locations:** trailing compressed padding cannot bypass the gunzip budget, and local-pack/tarball/npm reports never use a temporary extraction root; pinned by Tasks 5 and 6.

---

### Task 1: Package-scoped baseline and SARIF identity

**Files:**
- Modify: `src/core/baseline.js`
- Modify: `src/core/report.js:3,93-121`
- Modify: `bin/dsh-plugin-lint.mjs:329-345`
- Test: `test/baseline.test.js`
- Test: `test/report.test.js`
- Test: `test/lint-cli-contract.test.js:92-115`
- Modify: `README.md:264,713`

**Interfaces:**
- Produces: `fingerprint(finding, packageName?)`; omitting `packageName` retains the legacy hash, supplying it includes `package` in canonical JSON.
- Produces: baseline entries `{ fingerprint, package, rule, level, file, evidence }`; `package === report.target.name` and version/line remain excluded.
- Produces: SARIF key `dshPluginLint/v2` containing the package-scoped fingerprint.
- Consumes: legacy entries without `package` only when exactly one report is supplied; otherwise throw an error containing `single package` and `regenerate`.

- [ ] **Step 1: Write the failing identity and compatibility tests**

Add tests proving: identical findings from packages A and B receive different fingerprints; a baseline created from A suppresses A but not B; a two-package baseline retains both entries; an old hand-built single-package baseline still suppresses; that same legacy baseline with two reports throws the specified error; SARIF partial fingerprints differ by package and use `dshPluginLint/v2`.

Add a CLI test that a malformed baseline exits 2 without an uncaught stack, and a multi-package legacy baseline exits 2 with regeneration guidance.

- [ ] **Step 2: Run the tests and verify the new assertions fail**

Run: `node --test test/baseline.test.js test/report.test.js test/lint-cli-contract.test.js`
Expected: FAIL because B is currently suppressed, package-scoped fingerprints/v2 are absent, and baseline errors bypass the CLI error contract.

- [ ] **Step 3: Implement scoped creation, application, pruning, and rendering**

Extend the fingerprint signature above. Deduplicate new baseline entries by package plus scoped fingerprint. Build separate scoped and legacy lookup sets during apply/prune; allow legacy lookup only for one report. Validate optional `package` as a non-empty string when reading. Pass `report.target.name` from `toSarif()` and rename the partial-fingerprint key to v2. Wrap CLI baseline read/apply/prune/write operations in the normal `fail()` path without changing findings-gate exit 1.

- [ ] **Step 4: Run the affected tests**

Run: `node --test test/baseline.test.js test/report.test.js test/lint-cli-contract.test.js`
Expected: PASS, including old single-package suppression and new multi-package isolation.

- [ ] **Step 5: Update the documented fingerprint contract**

Change both README descriptions to `package + rule + file + normalized evidence`, note that version and line are excluded, and state that multi-package use of an unscoped legacy baseline requires regeneration. Run `git diff --check`.

### Task 2: Include deletions in incremental package discovery

**Files:**
- Modify: `src/core/changed.js:5-11`
- Test: `test/changed.test.js`

**Interfaces:**
- Preserves: `changedFiles({ cwd, ref, staged })` and `packageRoots(files, cwd)` signatures.
- Produces: deleted relative paths in `changedFiles()` using Git filter `ACMRD`.

- [ ] **Step 1: Write deletion-only worktree and staged tests**

In independent temporary Git repositories with `packages/a/package.json` naming `main: "index.js"` and a committed `packages/a/index.js`, delete only that entry. Assert `changedFiles()` contains the deleted path, `packageRoots()` selects package A, and the CLI reports A with E3. Repeat after `git add -u` for `--staged`; unrelated package B must not be selected.

- [ ] **Step 2: Run the deletion tests and verify they fail**

Run: `node --test test/changed.test.js`
Expected: FAIL because `changedFiles()` returns no deleted path and the CLI cannot select A.

- [ ] **Step 3: Implement the one-line filter correction**

Change the diff filter to `ACMRD`; do not alter the existing deleted-path handling in `packageRoots()`.

- [ ] **Step 4: Run the changed-file tests**

Run: `node --test test/changed.test.js`
Expected: PASS for modification, worktree deletion, staged deletion, and nearest-package mapping.

### Task 3: Align partial caret and x-ranges with node-semver

**Files:**
- Modify: `src/core/semver.js:12-16,55-80,119-130`
- Test: `test/semver.test.js`

**Interfaces:**
- Preserves: `satisfies(versionText, rangeText) -> true | false | null` and `isDecidableRange(text)`.
- Produces: `^0` upper bound `<1.0.0`, `^0.0` upper bound `<0.1.0`, and numeric-major `x/X/*` minor/patch x-ranges.

- [ ] **Step 1: Write table-driven boundary tests**

Pin at least: `^0` accepts `0.5.0` but not `1.0.0`; `^0.0` accepts `0.0.5` but not `0.1.0`; `^0.2` accepts `0.2.9` but not `0.3.0`; `1.x`, `1.X`, and `1.*` accept `1.4.0` but not `2.0.0`; `1.2.x` and `1.2.*` accept `1.2.8` but not `1.3.0`; `1.x.3` returns `null`.

- [ ] **Step 2: Run the semver tests and verify the boundary failures**

Run: `node --test test/semver.test.js`
Expected: FAIL with the current partial-caret upper bounds and `null` x-ranges.

- [ ] **Step 3: Implement partial-aware caret bounds and x parsing**

When parsing a caret, missing minor selects next-major; otherwise missing patch selects next-minor; a complete zero-major/zero-minor version retains next-patch. Extend partial parsing so wildcard minor/patch becomes missing precision, rejecting numeric precision after a wildcard. Leave unrelated comparator, prerelease, workspace, and unknown-range behavior unchanged.

- [ ] **Step 4: Run semver and peer-admission tests**

Run: `node --test test/semver.test.js test/lint.test.js`
Expected: PASS without new official-rule findings or changes to full caret ranges.

### Task 4: Match npm nested ignore basename semantics

**Files:**
- Modify: `src/core/packlist.js:48-67,161-173`
- Test: `test/packlist.test.js`

**Interfaces:**
- Preserves: `buildPacklist(dir, manifest)`, `globToRegExp(pattern)`, and `hasPackedFile()` signatures.
- Produces: ignore-only matching where a pattern without `/` matches any path segment at any depth; slash-containing patterns stay relative to the ignore file.

- [ ] **Step 1: Write direct and real-npm differential regressions**

Use a package whose intrinsic `main` is `index.js`, root ignore is `*.js\nicon.svg\n!keep.js`, and files include `lib/drop.js`, `lib/keep.js`, `lib/deep/nested.js`, `assets/icon.svg`, and `locale/en.json`. Assert the simulated set equals `npm pack --dry-run --json --ignore-scripts`: nested drops are absent, keep/locale are present, and intrinsic main remains present. Retain a case proving `files[]` disables root ignore.

- [ ] **Step 2: Run packlist tests and verify the nested differences**

Run: `node --test test/packlist.test.js`
Expected: FAIL because nested `*.js` and `icon.svg` are currently included.

- [ ] **Step 3: Implement ignore-specific segment matching**

Do not change `globToRegExp()` or `files[]` rule evaluation. For ignore rules, detect slash-containing versus basename patterns before normalizing away a leading slash; evaluate every path segment for basename patterns so a matched directory also excludes descendants. Preserve rule order and negation.

- [ ] **Step 4: Run all packlist differential tests**

Run: `node --test test/packlist.test.js`
Expected: PASS, including existing six npm dry-run cases and the new nested/negated cases.

### Task 5: Enforce the tar expansion budget during gunzip

**Files:**
- Modify: `src/core/tarball.js:5-7,42-65`
- Test: `test/pack.test.js:35-79`

**Interfaces:**
- Extends: `extractTarball(buffer, dest, { maxBytes = 268435456, maxEntries = 10000 } = {})`.
- Consumes: the same limits during gunzip and subsequent entry iteration; defaults remain the current production limits.

- [ ] **Step 1: Write a failing compressed-trailing-padding test**

Build a tar containing one small regular file, its two zero end blocks, and 8 KiB of additional compressible zero padding. With `{ maxBytes: 1024, maxEntries: 1 }`, assert extraction throws `/expands beyond the size limit/` and writes no file. The old parser accepts because the file body is small and it stops at the first zero block.

- [ ] **Step 2: Run the tar tests and verify the padding case fails**

Run: `node --test test/pack.test.js`
Expected: FAIL because the old implementation gunzips and accepts the trailing padding.

- [ ] **Step 3: Add the bounded gunzip call**

Validate injected limits as positive integers. Set `maxOutputLength` to entry-body budget plus at most two 512-byte blocks per allowed entry and two terminal blocks. Convert the zlib overflow into the stable `tarball expands beyond the size limit` error; preserve other zlib errors and all existing parser checks.

- [ ] **Step 4: Run tar and pack tests**

Run: `node --test test/pack.test.js`
Expected: PASS for bounded padding, traversal, normal npm extraction, and existing CLI pack contracts.

### Task 6: Use stable source and archive locations for packed reports

**Files:**
- Modify: `bin/dsh-plugin-lint.mjs:282-327`
- Test: `test/pack.test.js:100-157`

**Interfaces:**
- Produces: a CLI-local helper `lintAt(dir, options, reportPath = dir)` that calls `lintPackage()` and overrides only `report.target.path`.
- Produces: local pack root = original package directory; tarball root = `<absolute-archive>!/`; npm root = `npm:<spec>!/`.
- Preserves: `target.source`, findings, stable exports, `uriFor()`, and non-pack directory paths.

- [ ] **Step 1: Write failing SARIF tests for all three packed inputs**

Use a package with an E1 finding. For `--pack --format sarif`, assert the location resolves to the original package path and contains no `dsh-tarball-`. For a `.tgz`, assert `<archive>!/index.js`. For fake `npm pack` through `--from-npm`, assert `npm:from-npm-demo@1.0.0!/index.js`. Also assert GitHub output does not expose the temporary extraction root.

- [ ] **Step 2: Run pack tests and verify temporary paths are observed**

Run: `node --test test/pack.test.js`
Expected: FAIL because locations contain the extraction directory or lack the required stable roots.

- [ ] **Step 3: Implement the CLI-local report-root mapping**

Route npm, tarball, local-pack, and ordinary-directory calls through `lintAt()`. Supply the three stable roots above; do not mutate finding paths or move archive handling into the public linter API.

- [ ] **Step 4: Run pack and report/CLI contract tests**

Run: `node --test test/pack.test.js test/report.test.js test/lint-cli-contract.test.js`
Expected: PASS with unchanged ordinary relative paths and stable packed-artifact locations.

### Task 7: Whole-patch verification and delivery

**Files:**
- Review: all task diffs plus `docs/superpowers/specs/2026-11-23-core-correctness-design.md` and this plan.
- Modify only if a verification failure requires a task-scoped correction.

**Interfaces:**
- Produces: six independently testable fixes, a clean `git diff --check`, and an explicit list of unexecuted external validations.

- [ ] **Step 1: Run the complete unit suite and coverage gate**

Run: `npm test && npm run test:coverage`
Expected: 0 failures; line >=85%, branch >=80%, function >=80%. Record actual counts and all-files coverage without calling it production-only coverage.

- [ ] **Step 2: Run official, self-lint, and real-package smoke checks**

Run: `node scripts/e2e-official.mjs "/Users/eastbuy/Documents/dsh插件/dsh-plugin-lab/fixtures" --expect 80`
Run: `node bin/dsh-plugin-lint.mjs panel test/probe-plugins --no-color --exit-code`
Run: `node scripts/package-smoke.mjs`
Expected: 80 packages with zero errors; panel clean and fixture infos only; package smoke PASS.

- [ ] **Step 3: Inspect the final patch and working-tree boundary**

Run: `git diff --check && git status --short && git diff --stat`
Expected: no whitespace errors; only the six task areas, their tests, README, and approved design/plan documents differ; the original checkout remains untouched.

- [ ] **Step 4: Report evidence and remaining limits**

Summarize each red-to-green regression, actual verification output, and changed files. State explicitly that no dependency installation, third-party plugin execution, Docker/browser run, real-profile change, or npm publish occurred. After whole-branch review, commit with the required attribution and push only `worktree-dsh-core-correctness` to `origin`; do not claim the original feature branch, `main`, or the npm release contains the fixes.
