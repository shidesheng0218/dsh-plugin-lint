# Core correctness patch design

> Date: 2026-11-23 · Status: approved by the user in conversation
> Base: `origin/main@68fb800` in an isolated worktree

## Intent and why

Six independently reproduced defects let the published linter suppress another package's findings, skip deletion-only changes, disagree with node-semver, mis-model npm ignore files, decompress before enforcing its size budget, and emit locations under deleted temporary directories. This patch fixes those correctness boundaries before further feature work.

## Goals

- Scope baseline fingerprints and SARIF partial fingerprints by package name while retaining legacy single-package baselines.
- Include deleted files in `--changed` and `--staged` package discovery.
- Match node-semver for partial caret ranges and common x-ranges.
- Match npm ignore basename semantics without changing `files[]` selection semantics.
- Enforce a bounded tar output size during gunzip, before parsing or writing entries.
- Map packed-artifact report locations to stable source/archive paths instead of temporary extraction roots.
- Add failing regression tests before each implementation and finish with the complete local verification suite.

## Non-goals and anti-goals

- No matrix, probe, panel, upgrade, federation, or release-workflow changes.
- No new dependencies, AST rewrite, language migration, public rule API redesign, or broad refactoring.
- No third-party plugin execution, Docker matrix, real-profile modification, or npm publish. The user explicitly authorized one final commit and push of this isolated branch after review and verification; do not push `main` or create a PR.
- Do not keep applying an unscoped legacy baseline across multiple packages.
- Do not silently weaken existing path traversal, link, entry-count, or unpacked-byte checks.

## Constraints

- Node.js >=22, pure ESM, built-in modules only.
- Preserve existing stable exports and CLI defaults except for the defective behavior being fixed.
- Keep baseline schema version 1: new `package` metadata is additive; legacy entries are supported only for a single report.
- A package name change is a new baseline identity; package version and line numbers remain excluded.
- The original checkout and its uncommitted changes stay untouched.

## Approaches considered

1. **Focused zero-dependency patch in an isolated worktree — chosen.** It directly fixes the six reproduced defects and can be reviewed and merged independently.
2. Patch the current dirty feature checkout. Rejected because it mixes these fixes with unrelated matrix and reliability work.
3. Add semver/packlist/tar dependencies or combine this with the evidence-platform roadmap. Rejected as unnecessary scope and supply-chain expansion.

## Design by component

### Baseline

Extend `fingerprint(finding, packageName?)` so supplying a package name includes it in the canonical hash. Baseline creation and application pass `report.target.name`; new entries also record `package`. Entries without `package` use the old hash and are accepted only when exactly one report is being applied or pruned. Multi-report legacy baselines fail with an instruction to regenerate. SARIF uses the scoped fingerprint too. CLI baseline read/apply/prune errors use the normal exit-2 error path.

### Changed files

Use Git diff filter `ACMRD`. Existing `packageRoots()` already maps a deleted path to its former parent package. Test both worktree and staged deletion of a manifest-referenced entry, including the CLI's resulting E3 finding.

### Semver

For caret ranges, missing minor selects the next-major upper bound; missing patch with zero minor selects next-minor; full `0.0.x` retains next-patch. Parse numeric major followed by `x`, `X`, or `*` minor/patch components as partial x-ranges. Invalid mixed forms remain undecidable. Pin boundary values on both sides of each upper bound.

### Packlist

Separate ignore matching from `files[]` matching. Ignore patterns without a slash match path segments at any depth, including glob basenames and ignored directory descendants; patterns with a slash remain relative to their ignore file. Keep root-ignore disabling when `files[]` exists. Differential-test nested `*.js`, `icon.svg`, and negated `!keep.js` against real `npm pack --dry-run --json --ignore-scripts`.

### Tarball

Add optional `{ maxBytes, maxEntries }` limits to `extractTarball()` for deterministic tests. Pass a `maxOutputLength` to `gunzipSync()` that budgets entry bodies plus tar headers/padding, then retain the existing per-entry checks. A compressed archive with excessive trailing padding must fail under small injected limits even when its sole file body is below `maxBytes`.

### SARIF and GitHub locations

Add a small CLI lint helper that overrides only `report.target.path` after analysis. Local `--pack` maps back to the original package directory; `.tgz` uses `<absolute-archive>!/`; `--from-npm` uses `npm:<spec>!/`. Existing directory reports and `uriFor()` behavior remain unchanged. Test all three artifact sources and assert no `dsh-tarball-` path appears.

## Verification

Run each new test red before its implementation, then green. Finish with `npm test`, `npm run test:coverage`, the 80-official-package baseline, panel/probe-fixture self-lint, `node scripts/package-smoke.mjs`, and `git diff --check`. Report any skipped package-manager, network, Docker, browser, or third-party validation explicitly.

## Remaining builder choices

Exact helper names, error wording beyond the required regeneration guidance, and the smallest refactors needed to avoid duplicated baseline or CLI logic are left to the implementer within existing code style.
