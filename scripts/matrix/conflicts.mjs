#!/usr/bin/env node
/**
 * Composition conflicts: find plugins that claim the same name, and verify
 * what the host actually does about it.
 *
 *   node scripts/matrix/conflicts.mjs [--cells matrix/cells] [--verify] [--limit 3]
 *
 * Static pass, two dimensions:
 *   tools  read the matrix cells and group registered tool names by owner.
 *   slots  scan each plugin's client bundle for ctx.slots.register({ name })
 *          and group the slot names by owner. A name claimed by two plugins is
 *          a candidate conflict in either dimension.
 *
 * Verify pass (--verify): install each conflicting pair into one throwaway
 * profile and compare the merged tool list against the union of what the two
 * plugins registered when probed alone. A smaller merged list means the host
 * silently dropped one registration — a composition bug that no single-plugin
 * probe can see.
 *
 * Output is untracked: matrix/index/conflicts.json names packages.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCombo, probePackage, resolveDsh, startStub } from '../lib/probe.mjs';
import { loadPackage } from '../../src/load.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const cellsDir = argOf('--cells', join(ROOT, 'matrix/cells'));
const cacheRoot = argOf('--cache', join(ROOT, '.matrix-cache'));
const verify = argv.includes('--verify');
const limit = Number(argOf('--limit', '3'));
const dshVersion = argOf('--dsh', '0.2.0-rc.2');
// An explicit pair skips the static scan: controlled fixtures are how we learn
// what the host does about a collision, since the sampled ecosystem had none.
const explicit = (argOf('--plugins', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- static pass
const cells = [];
for (const dir of existsSync(cellsDir) ? readdirSync(cellsDir) : []) {
  const abs = join(cellsDir, dir);
  if (!statSync(abs).isDirectory()) continue;
  for (const file of readdirSync(abs)) {
    if (file.endsWith('.json')) cells.push(JSON.parse(readFileSync(join(abs, file), 'utf8')));
  }
}
if (cells.length === 0) {
  console.error('no cells under ' + cellsDir + ' — run scripts/matrix/run.mjs first');
  process.exit(2);
}

/** tool name -> the plugins that register it, with the cell that proves it. */
const owners = new Map();
const perPlugin = new Map();
for (const cell of cells) {
  const added = cell.result.tools?.added;
  if (!Array.isArray(added) || added.length === 0) continue;
  if (!perPlugin.has(cell.plugin.name)) perPlugin.set(cell.plugin.name, new Set());
  for (const tool of added) {
    perPlugin.get(cell.plugin.name).add(tool);
    if (!owners.has(tool)) owners.set(tool, new Map());
    owners.get(tool).set(cell.plugin.name, cell);
  }
}

const clashes = [...owners.entries()]
  .filter(([, byPlugin]) => byPlugin.size > 1)
  .map(([tool, byPlugin]) => ({
    tool,
    owners: [...byPlugin.entries()].map(([name, cell]) => ({
      plugin: name,
      dsh: cell.dsh.version,
      composition: cell.result.composition ?? 'headless',
      reproduce: cell.reproduce.command,
    })),
  }))
  .sort((a, b) => b.owners.length - a.owners.length || a.tool.localeCompare(b.tool));

console.log('cells read: ' + cells.length);
console.log('plugins that register tools: ' + perPlugin.size);
console.log('distinct tool names: ' + owners.size);
console.log('tool names claimed by more than one plugin: ' + clashes.length);
for (const clash of clashes.slice(0, 20)) {
  console.log('  ' + clash.tool + '  <-  ' + clash.owners.map((o) => o.plugin).join(', '));
}

// ---------------------------------------------------------------- slot pass
// Slots are not in the cells — a cell records what the host reported, and the
// host never sees a slot registration. So this pass fetches each covered
// plugin's tarball and scans its client bundle for the slot names it
// registers. The scan is static: it reads string literals, it does not run
// the bundle.
const slotOwners = new Map();
const slotScanned = [];
for (const name of perPlugin.keys()) {
  const pkgDir = join(cacheRoot, 'pkgs', name);
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) {
    // The matrix cells name packages the probe installed into throwaway
    // profiles; nothing kept them. Fetch the published tarball into the cache.
    mkdirSync(pkgDir, { recursive: true });
    const fetched = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name))
      .then((r) => r.json())
      .then((meta) => {
        const version = meta['dist-tags']?.latest;
        const url = meta.versions?.[version]?.dist?.tarball;
        return url ? { version, url } : undefined;
      })
      .catch(() => undefined);
    if (!fetched) continue;
    const tarball = await fetch(fetched.url).then((r) => r.arrayBuffer()).catch(() => undefined);
    if (!tarball) continue;
    writeFileSync(join(pkgDir, 'pkg.tgz'), Buffer.from(tarball));
    const { execFileSync } = await import('node:child_process');
    try { execFileSync('tar', ['xzf', 'pkg.tgz', '--strip-components=1'], { cwd: pkgDir, stdio: 'pipe' }); } catch { continue; }
  }
  if (!existsSync(manifestPath)) continue;
  const pkg = loadPackage(pkgDir);
  if (!pkg.entries.client || !pkg.exists(pkg.entries.client)) continue;
  const file = pkg.jsFiles.find((f) => f.path === pkg.entries.client);
  if (!file) continue;
  slotScanned.push(name);
  for (const s of file.strings) {
    if (!/^[a-z][a-z0-9.-]*$/.test(s.value)) continue;
    // ctx.slots.register({ name: '...' }) — the slot name is a string literal
    // whose nearby masked source names the registration call.
    if (!file.masked.slice(Math.max(0, s.start - 160), s.start).includes('slots.register')) continue;
    if (!slotOwners.has(s.value)) slotOwners.set(s.value, new Set());
    slotOwners.get(s.value).add(name);
  }
}
const slotClashes = [...slotOwners.entries()]
  .filter(([, plugins]) => plugins.size > 1)
  .map(([slot, plugins]) => ({ slot, plugins: [...plugins] }))
  .sort((a, b) => b.plugins.length - a.plugins.length || a.slot.localeCompare(b.slot));
console.log('plugins with a scannable client bundle: ' + slotScanned.length);
console.log('distinct slot names: ' + slotOwners.size);
console.log('slot names claimed by more than one plugin: ' + slotClashes.length);
for (const clash of slotClashes.slice(0, 20)) {
  console.log('  ' + clash.slot + '  <-  ' + clash.plugins.join(', '));
}

// ---------------------------------------------------------------- verify pass
const verified = [];
const toVerify = explicit.length >= 2
  ? [{ tool: '(explicit pair)', owners: explicit.map((p) => ({ plugin: p })) }]
  : (verify ? clashes.slice(0, limit) : []);
if (toVerify.length > 0) {
  const dsh = await resolveDsh(dshVersion, cacheRoot);
  for (const clash of toVerify) {
    const plugins = clash.owners.map((o) => o.plugin);
    // The comparison is "alone vs together". For cells that is already known; for
    // an explicit pair, probe each plugin alone first.
    const union = new Set();
    for (const plugin of plugins) for (const tool of perPlugin.get(plugin) ?? []) union.add(tool);
    const alone = [];
    if (union.size === 0) {
      for (const plugin of plugins) {
        const soloStub = await startStub();
        let solo;
        try {
          solo = await probePackage({ target: plugin, dsh, stub: soloStub, tools: true });
        } finally {
          soloStub.server.close();
        }
        alone.push({ plugin, status: solo.status, tools: solo.tools?.added ?? [] });
        for (const tool of solo.tools?.added ?? []) union.add(tool);
        console.log('  alone: ' + plugin + ' -> ' + solo.status + ', +' + (solo.tools?.added?.length ?? 0) + ' tools');
      }
    }
    const stub = await startStub();
    let combo;
    try {
      combo = await probeCombo({ targets: plugins, dsh, stub, tools: true });
    } finally {
      stub.server.close();
    }
    const merged = new Set(combo.tools?.added ?? []);
    const dropped = [...union].filter((t) => !merged.has(t));
    // Two plugins claiming the SAME name produce an empty set difference, so the
    // set is not the signal here — the host refusing the second registration is.
    // Measured: "tool \"x\" is already registered", and the later plugin fails to
    // activate entirely.
    const refused = combo.entries.filter((e) => /already registered/i.test(e.reason || ''));
    const failed = combo.entries.filter((e) => /Error/.test(e.reason || ''));
    const entry = {
      tool: clash.tool,
      plugins,
      unionSize: union.size,
      mergedSize: merged.size,
      unionKnown: union.size > 0,
      alone,
      dropped,
      status: combo.status,
      entries: combo.entries,
      durationMs: combo.durationMs,
      verdict: union.size === 0
        ? 'measured together; run each alone for the union to compare against'
        : refused.length > 0
          ? 'collision: the host refused the later registration and that plugin did not activate'
          : failed.length > 0
            ? 'a plugin failed to activate together that activated alone'
            : dropped.length === 0
              ? 'both registered'
              : 'registration lost',
      refused: refused.map((e) => ({ id: e.id, reason: e.reason })),
      failedTogether: failed.map((e) => ({ id: e.id, reason: e.reason })),
      reproduce: 'node scripts/probe-boot.mjs ' + plugins.join(' ') + ' --tools --dsh ' + dshVersion,
    };
    verified.push(entry);
    console.log('\nverifying ' + clash.tool + ' across ' + plugins.join(' + '));
    console.log('  status      ' + combo.status + '  (' + combo.durationMs + ' ms)');
    console.log('  tools alone ' + union.size + '  merged ' + merged.size);
    console.log('  verdict     ' + entry.verdict + (dropped.length ? ': lost ' + dropped.join(', ') : ''));
    for (const a of alone) if (a.status !== 'active') console.log('  alone       ' + a.plugin + ' was ' + a.status);
    for (const e of combo.entries) console.log('  inactive    ' + e.id + ': ' + e.reason);
  }
}

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  cells: cells.length,
  pluginsRegisteringTools: perPlugin.size,
  distinctToolNames: owners.size,
  clashes,
  slots: {
    scanned: slotScanned.length,
    distinctNames: slotOwners.size,
    clashes: slotClashes,
  },
  verified,
  scope: 'Tool names come from probe cells (what the host registered); slot names come from a static scan of client bundles (what the code declares). A shared name is a candidate conflict until the verify pass says what the host does with it. Routes and loader rows are not compared yet.',
};
mkdirSync(join(ROOT, 'matrix/index'), { recursive: true });
writeFileSync(join(ROOT, 'matrix/index/conflicts.json'), JSON.stringify(out, null, 2) + '\n');
console.log('\nwritten to matrix/index/conflicts.json');
