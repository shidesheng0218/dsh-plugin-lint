# dsh-plugin-lint-panel

A DeepSeek Harness settings section — **Plugin Health Center** — that lists the plugins installed in this profile and how each one fares across DSH versions, read from the compatibility matrix.

## Payload v2 and route security

The host is split into `profile/`, `matrix/`, `payload/`, `update/`, `actions/`, and `routes/`. The main payload uses `schemaVersion: 2` and never waits for the registry; update checks are a separate, low-priority `POST /api/dsh-plugin-lint/panel/update` request with a 4-second timeout and a 6-hour cache. Update failure hides only the update prompt and never clears local evidence. Aggregate-only installs still include counts, snapshot date, and source run id when the source provides one. Legacy cells are labelled `legacy-unpinned`, are shown only as historical evidence, and cannot justify an upgrade recommendation.

`recorded-active` means that an isolated probe previously recorded `active`; it does **not** mean that the currently running profile is healthy or that its browser client was exercised. The UI uses recorded / attention / unverified rather than a live-health score. Matrix cells retain their composition and trust metadata, and static conflict candidates remain separate from runtime results.

Action requests require `content-type: application/json`, `x-dsh-plugin-lint-action: 1`, `confirmed: true`, a valid package name, and an installed exact version. The panel itself and first-party bundles are protected server-side. Execution uses `execFile`, a per-profile lock, and a sanitized audit (no env, argv, stdout, stderr, or tokens). **These server-side checks are in the unreleased 0.2.0 release candidate.** The published 0.1.5 predates them: its action route has no content-type, confirmation, protected-package, or installed-only check and hardcodes `--profile desktop`. Do not install 0.1.5 into a profile that runs untrusted plugins; see Install.

**DSH authentication evidence:** the supported `@deepseek-ai/dsh-client-connection` packages at `0.2.0-rc.2` and `0.2.1-alpha.2` implement a signed, authority-bound browser cookie (`lib/index.js`, `BrowserAuth`) and a Host/Origin request fence (`isTrustedApiRequest`). A missing `Origin` is explicitly accepted by that implementation, so it is not treated as a vulnerability here. When `Origin` is present, this panel requires it to match the forwarded `Host` header (the bridge rewrites `request.url` to `http://dsh.internal`, so the URL host is not the browser's authority), and also enforces JSON, the custom action header, confirmation, and installation state.

## What it shows

| Column / block | Meaning |
| --- | --- |
| Plugin | the bundle this profile selected, with the version actually installed |
| One column per DSH version | the probe verdict in that version's cell |
| Ecosystem counts | per-version tallies of active / awaiting-service / rejected-by-host / install-failed; never a package name |

Rows need a **full** matrix snapshot. The panel obtains one in three ways, in this order:

1. **Automatic background sync (currently inactive).** On load, the panel tries to refresh a per-profile cache (`<profile>/.dsh-plugin-lint/matrix`) from `matrix/public/` in the source repository, fetched over HTTPS and verified byte-for-byte against its hash manifest. `matrix/public/` is **not published**: `matrix/public/` is gitignored under the data policy and the workflow that would create it is manual and gated on an explicit `publish_named_data` decision. Until that decision is made and the artifact exists, the refresh resolves to a 404 and the panel keeps the bundled aggregate. Hash verification detects corruption, not publisher identity (the manifest is not signed).
2. **An explicit override.** Set `DSH_PLUGIN_LINT_INDEX` to a full snapshot path, or `DSH_PLUGIN_LINT_CACHE` to point the cache elsewhere.
3. **The bundled aggregate.** The npm package ships only `data/aggregate.json` (counts per version, no package names). With no cache and no override, an npm-installed panel shows the aggregate picture and marks installed plugins as uncovered.

Per-plugin rows require a full snapshot: a local checkout with `data/matrix-index.json`, an explicit `DSH_PLUGIN_LINT_INDEX` override, or a published `matrix/public/` artifact once the data-policy decision allows one. A plain npm install shows aggregate counts only.

## Data and its limits

| File | Content | Tracked / shipped |
| --- | --- | --- |
| `<profile>/.dsh-plugin-lint/matrix/` | synced public snapshot, fetched and hash-verified at runtime | generated locally per profile, never committed |
| `data/matrix-index.json` | full matrix snapshot with package names and per-plugin verdicts | generated locally, gitignored, **not** in the npm package |
| `data/aggregate.json` | per-version counts only | tracked, and the only data file in the npm package |

Current local snapshot: 50 plugins × 2 DSH versions × 2 compositions = 200 cells, collected on 2026-10-16. This is a **legacy-unpinned** snapshot, not current verified evidence.

- In 23 of the 200 legacy cells the recorded `plugin.version` differs from the version the cell says was actually installed, and the reproduce command does not pin that version. These cells remain visible for historical context but are not recommended for upgrade decisions.
- `scripts/matrix/bundle-panel-data.mjs` prefers `matrix/public/` and calls the public artifact's schema, hash, index, aggregate, and count verification before writing either output. A legacy `matrix/index/latest.json` is accepted only as a local compatibility fallback.
- **`matrix/cells/`, `matrix/index/`, and `matrix/public/` are generated artifacts** and are gitignored. Publishing `matrix/public/` is an explicit data-policy decision (`matrix refresh` with `publish_named_data=true`); it is not the default. Rebuilding needs the pinned inputs and a working isolated probe backend; no successful run is inferred from unit tests.
- The local snapshot covers only `0.2.0-rc.2` and `0.2.1-alpha.2`.

## Install

```bash
# from npm (latest published version: 0.1.5; the 0.2.0 in this checkout is a release candidate, unpublished)
dsh plugin --profile <profile> add @shidesheng0218/dsh-plugin-lint-panel
```

> **0.1.5 security note.** The published 0.1.5 action route accepts any JSON body
> naming a plugin and runs `dsh plugin --profile desktop remove/add` without a
> confirmation, protected-package, or installed-only check. Any same-origin
> plugin client can call it, and on a non-desktop profile it mutates the desktop
> profile. Install 0.2.0 (or a later release) when it is available, or keep the
> panel out of profiles that run untrusted plugins until then.

Per-plugin matrix rows require a snapshot (see above); no checkout is needed only after a `matrix/public/` artifact is published. From a checkout you can pre-seed the snapshot with `node scripts/matrix/bundle-panel-data.mjs`, then `dsh plugin --profile <profile> add <absolute path to this directory>`.

The profile then shows a **Plugin Health Center** section in Settings.

## How it is built

- **Host half** (`index.js`): registers the main payload, action, and update POST routes through the connection service (optional — in a headless profile the plugin still mounts and registers no route). Actions execute `dsh plugin add` / `remove` after the documented request, confirmation, and installation checks — they really install or uninstall packages, they are not simulated.
- **Browser half** (`client.js`): one `settings.section` registration and top-level view-model functions. Only `react` comes from the browser module table; there is no browser import or build step, and colours use the `--dsw-alias-*` tokens with fallbacks.
- An error boundary wraps the component: a throwing component blanks its whole slot entry, and a blank settings page is a worse failure than a message.

## Verification status

| Check | Result |
| --- | --- |
| Host half mounts on DSH 0.2.0-rc.2, headless and web | ✅ `active` both |
| Host half mounts on DSH 0.2.1-alpha.2, headless and web | ✅ `active` both |
| `dsh-plugin-lint` on this package | ✅ 0 error, 0 warn, 0 info (11 checks) |
| Host, routes, client, and bundle behavior | ✅ `test/panel*.test.js` |
| Page rendered in a real browser | ✅ screenshotted (see below) |

Visual verification is [scripts/screenshot-panel.mjs](../scripts/screenshot-panel.mjs): it installs this package into a throwaway web profile, opens the app in Chromium and captures the section. It caught two bugs a code review had not — the page said "Running DSH unknown" because `import.meta.resolve` cannot see the harness from inside a profile, and it called first-party bundles "not installed" although the dsh installation provides them.

```bash
node scripts/screenshot-panel.mjs        # writes docs/assets/panel.png
```

## Limitations

- **Client half is not covered by the probe**: a verdict describes the host half of a plugin; the browser half is not exercised. The separate real-browser screenshot verifies the panel's own rendering, not every plugin's client.
- **Per-plugin data requires a local snapshot** (see above); npm installs show aggregate counts only.
- **The automatic sync has no source yet**: `matrix/public/` is gitignored and not published, so the default URL resolves to 404 and the panel keeps the bundled aggregate. This is a data-policy decision, not a transient outage.
- Aggregate v2 includes `sourceRunId` when a verified public export supplies it. A legacy local fallback may lack run provenance and is not publishable v2 evidence.
- The panel's update check calls the npm registry (4 s timeout, 6 h cache, failure silent); it is a convenience, not a dependency.
