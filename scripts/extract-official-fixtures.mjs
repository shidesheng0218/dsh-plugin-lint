#!/usr/bin/env node
/**
 * Extract official @deepseek-ai packages from an installed DSH asar into
 * fixtures/, so the zero-false-positive baseline runs against the real thing.
 *
 *   node scripts/extract-official-fixtures.mjs [--asar <path>] [--limit <n>]
 *
 * The asar is readable only by the DSH host process (Electron's original-fs);
 * plain fs is patched to treat .asar paths as directories and will fail.
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ASAR = argOf('--asar', '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const OUT = argOf('--out', fileURLToPath(new URL('../fixtures', import.meta.url)));
const KEEP = /\.(js|mjs|json|yml|yaml|svg)$/;
const SKIP_DIRS = new Set(['node_modules', 'src']);

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
  return buf;
};

const names = Object.keys(header.files.dsh.files.node_modules.files['@deepseek-ai'].files);
rmSync(OUT, { recursive: true, force: true });
let packages = 0;
let files = 0;
for (const name of names) {
  if (LIMIT && packages >= LIMIT) break;
  const base = 'dsh/node_modules/@deepseek-ai/' + name;
  const root = findNode(base);
  if (!root || !root.files) continue;
  const hasLib = Boolean(root.files.lib && root.files.lib.files);
  const pkgJson = readFile(base + '/package.json');
  if (!hasLib || !pkgJson) continue;
  const write = (rel, buf) => {
    if (!buf) return;
    const dest = join(OUT, name, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    files += 1;
  };
  write('package.json', pkgJson);
  const walk = (prefix, node) => {
    for (const [child, sub] of Object.entries(node.files || {})) {
      const rel = prefix ? prefix + '/' + child : child;
      if (sub.files) {
        if (SKIP_DIRS.has(child)) continue;
        walk(rel, sub);
      } else if (KEEP.test(child)) {
        write(rel, readFile(base + '/' + rel));
      }
    }
  };
  walk('', root);
  packages += 1;
}
console.log('extracted ' + packages + ' official packages, ' + files + ' files -> ' + OUT);
