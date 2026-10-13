#!/usr/bin/env node
/**
 * Harvest the session event-type allowlist from an installed DSH.
 *
 *   node scripts/harvest-event-types.mjs [--asar <path>]
 *
 * The Harness has no single file listing its session event types: plugins append
 * them, and the format catalog only versions the physical encoding. So this
 * harvests two overlapping sources from the official packages:
 *
 *   1. \`session.append("type", data)\` call sites - certain event types.
 *   2. every \`namespace/type\` string literal anywhere in official code - a wider
 *      net that also catches types appended through helpers or built dynamically.
 *
 * The allowlist is deliberately generous. A rule that flags a type the official
 * code never mentions anywhere is defensible; a rule that flags one the official
 * code uses would be a false accusation. Measured on 2026-10-13: source 1 alone
 * produced two false positives (command/run, command/done).
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ASAR = argOf('--asar', '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');

/** Strings shaped like ns/type that are certainly not session events. */
const NOT_AN_EVENT = /^(?:api|assets|static|node|text|application|image|video|audio|font|multipart|react|react-dom|preact|vue|svelte|lodash|rxjs|date-fns)\//;
const SHAPE = /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/;

const require = createRequire(import.meta.url);
let originalFs;
try { originalFs = require('original-fs'); } catch { originalFs = require('node:fs'); }

const fd = originalFs.openSync(ASAR, 'r');
const sizeBuf = Buffer.alloc(8);
originalFs.readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
originalFs.readSync(fd, headerBuf, 0, headerSize, 8);
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + headerBuf.readUInt32LE(4)));
const baseOffset = 8 + headerSize;

const findNode = (p) => {
  let node = header;
  for (const part of p.split('/').filter(Boolean)) {
    node = node.files ? node.files[part] : undefined;
    if (!node) return undefined;
  }
  return node;
};
const readFile = (p) => {
  const node = findNode(p);
  if (!node || node.files) return undefined;
  const offset = Number(node.offset);
  if (!Number.isFinite(offset)) return undefined;
  const buf = Buffer.alloc(Number(node.size));
  originalFs.readSync(fd, buf, 0, buf.length, baseOffset + offset);
  return buf.toString('utf8');
};

const names = Object.keys(header.files.dsh.files.node_modules.files['@deepseek-ai'].files);
const appended = new Set();
const observed = new Set();
let files = 0;
for (const name of names) {
  const base = 'dsh/node_modules/@deepseek-ai/' + name;
  const libDir = findNode(base)?.files?.lib;
  if (!libDir?.files) continue;
  for (const file of Object.keys(libDir.files)) {
    if (!file.endsWith('.js')) continue;
    const src = readFile(base + '/lib/' + file);
    if (!src) continue;
    files += 1;
    for (const m of src.matchAll(/\.append\(\s*["'\u0060]([a-z][a-z0-9-]*\/[a-z0-9-]+)["'\u0060]/g)) appended.add(m[1]);
    for (const m of src.matchAll(/["'\u0060]([a-z][a-z0-9-]*\/[a-z0-9-]+)["'\u0060]/g)) {
      if (!NOT_AN_EVENT.test(m[1])) observed.add(m[1]);
    }
  }
}
const types = [...new Set([...appended, ...observed])].sort();
const out = {
  $comment: 'Session event types observed in the official DeepSeek Harness packages. Regenerate with scripts/harvest-event-types.mjs against an installed DSH.',
  source: 'DeepSeek Harness (MIT); harvested from @deepseek-ai/* lib bundles',
  harvestedAt: new Date().toISOString().slice(0, 10),
  filesScanned: files,
  appendSiteTypes: appended.size,
  observedTypes: observed.size,
  types,
};
const dest = fileURLToPath(new URL('../src/data/event-types.json', import.meta.url));
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log('harvested ' + types.length + ' types (' + appended.size + ' from append sites, ' + observed.size + ' observed) from ' + files + ' files -> ' + dest);
