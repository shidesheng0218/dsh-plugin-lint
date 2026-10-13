# dsh-plugin-lint-panel

A DeepSeek Harness settings section that lists the plugins installed in this profile and how each one fares across DSH versions, read from the compatibility matrix.

## What it shows

| Column | Meaning |
| --- | --- |
| Plugin | the bundle this profile selected, with the version actually installed |
| One column per DSH version | the probe verdict in that version's cell |

Verdicts come from `matrix/index/latest.json`, snapshotted into `data/matrix-index.json` at build time, so the page works offline and can only show verdicts this project published.

## Install

```bash
dsh plugin --profile <profile> add <path-to-this-directory>
```

The profile then shows a **Plugin compatibility** section in Settings.

## How it is built

- **Host half** (`index.js`): registers one POST route, `/api/dsh-plugin-lint/panel", through the connection service. That service is optional, so in a profile without it (headless) the plugin still mounts and simply registers no route.
- **Browser half** (`client.js`): one `settings.section` registration. Only `react` comes from the browser module table; no Harness Client package is loaded, and colours use the `--dsw-alias-*` tokens with fallbacks.
- An error boundary wraps the component: a throwing component blanks its whole slot entry, and a blank settings page is a worse failure than a message.

## Verification status

| Check | Result |
| --- | --- |
| Host half mounts on DSH 0.2.0-rc.2, headless and web | ✅ `active` both |
| Host half mounts on DSH 0.2.1-alpha.2, headless and web | ✅ `active` both |
| `dsh-plugin-lint` on this package | ✅ 0 error, 0 warn, 0 info |
| Host payload logic (installed bundles joined against the matrix) | ✅ unit tested |
| **What the page looks like in a browser** | ✅ **verified, and screenshotted** |

Visual verification is [scripts/screenshot-panel.mjs](../scripts/screenshot-panel.mjs): it installs this package into a throwaway web profile, opens the app in Chromium and captures the section. It caught two bugs a code review had not — the page said "Running DSH unknown" because `import.meta.resolve` cannot see the harness from inside a profile, and it called first-party bundles "not installed" although the dsh installation provides them.

```bash
node scripts/screenshot-panel.mjs        # writes docs/assets/panel.png
```
