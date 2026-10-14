#!/usr/bin/env node
/**
 * Boot a throwaway web profile with the panel installed, open it in Chromium and
 * capture what the settings section actually looks like.
 *
 *   node scripts/screenshot-panel.mjs [--out docs/assets] [--explore] [--keep]
 *
 * This is the visual verification the panel README said was missing. It never
 * touches a real profile: everything happens in a temporary DSH_HOME.
 *
 * The web profile serves until killed, so both the materialisation step and the
 * server step use runUntilReady rather than waiting for an exit — measured: a
 * wait-for-exit version hung forever on step one.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WEB_READY, runUntilReady } from './lib/probe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT = resolve(argOf('--out', join(ROOT, 'docs/assets')));
const KEEP = argv.includes('--keep');
const EXPLORE = argv.includes('--explore');
const DSH_VERSION = argOf('--dsh', '0.2.0-rc.2');
const CLI = join(ROOT, '.matrix-cache/dsh', DSH_VERSION, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const PANEL = join(ROOT, 'panel');

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

const home = mkdtempSync(join(tmpdir(), 'dsh-shot-'));
const env = { ...process.env, DSH_HOME: home };
const dsh = { id: 'npm:' + DSH_VERSION, kind: 'npm', node: process.execPath, cli: CLI, extraArgs: [] };
const urlOf = (text) => (/dsh web:\s*(https?:\/\/\S+)/.exec(text) || [])[1];

const runToExit = (args) => new Promise((res) => {
  const child = spawn(process.execPath, [CLI, ...args], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', () => res(out));
});

console.log('1/5 laying the web profile down');
await runUntilReady(dsh, home, ['--profile', 'web', '--port', '0', '--no-open'], {}, WEB_READY, { timeoutMs: 90000, graceMs: 800 });

console.log('2/5 installing the panel');
const installLog = await runToExit(['plugin', '--profile', 'web', 'add', PANEL]);
const installLine = installLog.split('\n').filter((l) => /added|dependencies|rejected|Error/.test(l)).slice(0, 2).join(' | ');
console.log('    ' + (installLine || '(no install output)'));

// A profile holding only the panel itself makes a dull screenshot: every cell
// is "not covered". --with <pkg> installs one matrix-covered plugin too, so the
// pills render. The extra install goes into the same throwaway home.
const extraPlugin = argOf('--with', '');
if (extraPlugin) {
  const extraLog = await runToExit(['plugin', '--profile', 'web', 'add', extraPlugin]);
  const extraLine = extraLog.split('\n').filter((l) => /added|dependencies|rejected|Error/.test(l)).slice(0, 2).join(' | ');
  console.log('    also installed ' + extraPlugin + ': ' + (extraLine || '(no install output)'));
}

console.log('3/5 starting the web server');
const server = spawn(process.execPath, [CLI, '--profile', 'web', '--port', '0', '--no-open'], { env });
let log = '';
const url = await new Promise((resolveUrl) => {
  const feed = (chunk) => {
    log += chunk;
    const found = urlOf(log);
    if (found) resolveUrl(found);
  };
  server.stdout.on('data', feed);
  server.stderr.on('data', feed);
  setTimeout(() => resolveUrl(undefined), 90000);
});
if (!url) {
  console.error('the web server never reported a URL:\n' + log.slice(-800));
  server.kill('SIGKILL');
  process.exit(2);
}
console.log('    ' + url.replace(/token=[^&]+/, 'token=<redacted>'));

console.log('4/5 opening it in Chromium');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(7000);

// Scratch captures are written only when exploring; the deliverable is panel.png.
const text = await page.evaluate(() => document.body.innerText);
if (EXPLORE) {
  await page.screenshot({ path: join(OUT, 'panel-explore.png') });
  writeFileSync(join(OUT, 'panel-explore.txt'), text);
  console.log('    saved panel-explore.png + .txt (scratch)');
  console.log('\n--- visible text (first 1200) ---');
  console.log(text.slice(0, 1200));
}

// ---------------------------------------------------------------- the capture
// A first run shows a preview notice; dismiss it, then open Settings and find the
// section this plugin registers.
const clickIfPresent = async (locator, label) => {
  try {
    const target = locator.first();
    if (await target.isVisible({ timeout: 4000 })) {
      await target.click({ timeout: 5000 });
      console.log('    clicked ' + label);
      await page.waitForTimeout(1200);
      return true;
    }
  } catch { /* the control was not there; the next step reports what is */ }
  return false;
};

await clickIfPresent(page.getByRole('button', { name: /continue/i }), 'Continue (preview notice)');
// A throwaway profile has no credentials, so the app asks for an API key before
// anything else. The panel does not need one.
await clickIfPresent(page.getByRole('button', { name: /configure later/i }), 'Configure later (onboarding)');
await page.waitForTimeout(1500);
await clickIfPresent(page.getByText('Settings', { exact: true }), 'Settings');
await page.waitForTimeout(3000);
const settingsText = await page.evaluate(() => document.body.innerText);
if (EXPLORE) {
  await page.screenshot({ path: join(OUT, 'settings.png') });
  writeFileSync(join(OUT, 'settings.txt'), settingsText);
  console.log('    saved settings.png + .txt (scratch)');
}

// The label first matches the sidebar entry, which is itself the proof that the
// plugin registered a settings section — so capture that, then click through to
// the section's own content.
const navEntry = page.getByText('Plugin compatibility', { exact: false }).first();
let found = false;
try {
  if (await navEntry.isVisible({ timeout: 5000 })) {
    if (EXPLORE) {
      await page.screenshot({ path: join(OUT, 'settings-nav.png') });
      console.log('    saved settings-nav.png (scratch)');
    }
    await navEntry.click({ timeout: 5000 });
    await page.waitForTimeout(3500);
    found = true;
  }
} catch { found = false; }

if (found) {
  await page.screenshot({ path: join(OUT, 'panel.png') });
  console.log('    saved panel.png (the section content)');
  const panelText = await page.evaluate(() => document.body.innerText);
  if (EXPLORE) {
    writeFileSync(join(OUT, 'panel.txt'), panelText);
    console.log('\n--- panel text (first 1200) ---');
    console.log(panelText.slice(0, 1200));
  }
} else {
  console.log('    the section label was not found; see settings.txt');
}
if (EXPLORE) {
  console.log('\n--- settings text (first 1500) ---');
  console.log(settingsText.slice(0, 1500));
  console.log('\n--- console errors ---');
  console.log(errors.slice(0, 6).join('\n') || '(none)');
}

console.log('5/5 cleaning up');
await browser.close();
server.kill('SIGTERM');
setTimeout(() => server.kill('SIGKILL'), 1500).unref();
if (!KEEP) rmSync(home, { recursive: true, force: true });
console.log('done');
