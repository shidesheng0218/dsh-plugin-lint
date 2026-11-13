import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
const MAX_ENTRIES = 10000;
const MAX_BYTES = 256 * 1024 * 1024;

function text(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function safeRelative(name) {
  const normalized = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('tarball entry escapes the extraction directory: ' + name);
  }
  return normalize(normalized);
}

function parsePax(body) {
  const records = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number(body.subarray(offset, space).toString('ascii'));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * Extract an npm tarball without dependencies. Only regular files and
 * directories are written; symlinks, hardlinks, and path traversal are
 * rejected. Returns the extracted file list.
 */
export function extractTarball(buffer, dest) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  let entries = 0;
  let bytes = 0;
  let pax = {};
  let longName;
  const files = [];
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header, 0, 100);
    const size = parseInt(text(header, 124, 12) || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header, 345, 155);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('tarball entry extends past the archive: ' + name);
    const body = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    entries += 1;
    if (entries > MAX_ENTRIES) throw new Error('tarball has too many entries');
    bytes += size;
    if (bytes > MAX_BYTES) throw new Error('tarball expands beyond the size limit');

    if (type === 'x' || type === 'g') { pax = { ...pax, ...parsePax(body) }; continue; }
    if (type === 'L') { longName = text(body, 0, body.length); continue; }

    const rawPath = longName || pax.path || (prefix ? prefix + '/' + name : name);
    longName = undefined;
    pax = {};

    if (type === '5') {
      mkdirSync(join(dest, safeRelative(rawPath)), { recursive: true });
      continue;
    }
    if (type === '0' || type === '\0' || type === '7') {
      const path = join(dest, safeRelative(rawPath));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      files.push(safeRelative(rawPath));
      continue;
    }
    if (type === '1' || type === '2') {
      throw new Error('tarball contains a link: ' + rawPath);
    }
  }
  return files;
}