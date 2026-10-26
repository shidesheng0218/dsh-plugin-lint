# dsh-plugin-lint-panel

A DeepSeek Harness settings section — **Plugin Health Center** — that lists the plugins installed in this profile and how each one fares across DSH versions, read from the compatibility matrix.

## What it shows

| Column / block | Meaning |
| --- | --- |
| Plugin | the bundle this profile selected, with the version actually installed |
| One column per DSH version | the probe verdict in that version's cell |
| Ecosystem counts | per-version tallies of active / awaiting-service / rejected-by-host / install-failed; never a package name |

Rows need a **full** matrix snapshot. The npm package only ships `data/aggregate.json` (counts per version, no package names), so an npm-installed panel shows the aggregate picture and marks installed plugins as uncovered. Per-plugin rows need a local `data/matrix-index.json`, generated with `node scripts/matrix/bundle-panel-data.mjs` from a checkout, or a path set through the `DSH_PLUGIN_LINT_INDEX` environment variable.

## Data and its limits

| File | Content | Tracked / shipped |
| --- | --- | --- |
| `data/matrix-index.json` | full matrix snapshot with package names and per-plugin verdicts | generated locally, gitignored, **not** in the npm package |
| `data/aggregate.json` | per-version counts only | tracked, and the only data file in the npm package |

Current snapshot: 50 plugins × 2 DSH versions × 2 compositions = 200 cells, collected on 2026-10-16.

- **Recorded version ≠ loaded version.** In 23 of the 200 cells the recorded `plugin.version` differs from the version the cell says was actually installed; the cell's `reproduce` command does not pin a version. Treat the per-plugin verdicts as a snapshot, not as a precisely reproducible current state.
- **`matrix/cells/` and `matrix/index/` are gitignored**, so a clean clone cannot rebuild the snapshot; rebuilding needs network access, npm and the probe.
- The snapshot covers only `0.2.0-rc.2` and `0.2.1-alpha.2`.

## Install

```bash
# from npm (latest published version: 0.1.5; the 0.1.6 in this checkout is unpublished)
dsh plugin --profile <profile> add @shidesheng0218/dsh-plugin-lint-panel

# from a checkout, to get per-plugin matrix rows
node scripts/matrix/bundle-panel-data.mjs
dsh plugin --profile <profile> add <absolute path to this directory>
```

The profile then shows a **Plugin Health Center** section in Settings.

## How it is built

- **Host half** (`index.js`): registers a POST route `/api/dsh-plugin-lint/panel` through the connection service (optional — in a headless profile the plugin still mounts and registers no route), plus a second POST route for the fix/isolate actions. Those actions execute `dsh plugin add` / `remove` after a same-origin check and a `confirmed: true` body — they really install or uninstall packages, they are not simulated.
- **Browser half** (`client.js`): one `settings.section` registration. Only `react` comes from the browser module table; no Harness Client package is loaded, and colours use the `--dsw-alias-*` tokens with fallbacks.
- An error boundary wraps the component: a throwing component blanks its whole slot entry, and a blank settings page is a worse failure than a message.

## Verification status

| Check | Result |
| --- | --- |
| Host half mounts on DSH 0.2.0-rc.2, headless and web | ✅ `active` both |
| Host half mounts on DSH 0.2.1-alpha.2, headless and web | ✅ `active` both |
| `dsh-plugin-lint` on this package | ✅ 0 error, 0 warn, 0 info (11 checks) |
| Host payload logic (installed bundles joined against the snapshot) | ✅ 14 node:test cases in `test/panel.test.js` |
| Page rendered in a real browser | ✅ screenshotted (see below) |

Visual verification is [scripts/screenshot-panel.mjs](../scripts/screenshot-panel.mjs): it installs this package into a throwaway web profile, opens the app in Chromium and captures the section. It caught two bugs a code review had not — the page said "Running DSH unknown" because `import.meta.resolve` cannot see the harness from inside a profile, and it called first-party bundles "not installed" although the dsh installation provides them.

```bash
node scripts/screenshot-panel.mjs        # writes docs/assets/panel.png
```

## Limitations

- **Client half is not covered by the probe**: a verdict describes the host half of a plugin; the browser half is not exercised.
- **per-plugin data requires a local snapshot** (see above); npm installs show aggregate counts only.
- The bundled aggregate has no per-run provenance beyond `generatedAt` and the version list: it is generated from the local matrix index by `scripts/matrix/bundle-panel-data.mjs`.
- The panel's update check calls the npm registry (4 s timeout, 6 h cache, failure silent); it is a convenience, not a dependency.
