import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { maskSource } from './mask.js';

/** Directories that never hold shipped plugin code. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.husky', '.dsh-testkit', 'coverage', 'fixtures',
  'test', 'tests', '__tests__', '__snapshots__', 'dist-test',
]);

/** Guard rails so one huge vendored file cannot stall a run. */
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 3000;

export function loadPackage(dir) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) throw new Error('not a package directory (no package.json): ' + dir);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const norm = (p) => (p === undefined ? undefined : String(p).replace(/^\.\//, ''));
  const entries = {
    host: norm(firstString(manifest.main) || exportTarget(manifest.exports, '.') || 'index.js'),
    client: norm(exportTarget(manifest.exports, './client') || (manifest.dsh && manifest.dsh.client ? 'client.js' : undefined)),
    patch: norm(manifest.dsh && manifest.dsh.bundle ? firstString(manifest.dsh.bundle.patch) : undefined),
    icon: norm(firstString(manifest.icon)),
    localeDir: existsSync(join(dir, 'locale')) ? 'locale' : undefined,
  };

  const jsFiles = [];
  collect(dir, dir, jsFiles);

  return {
    dir,
    manifest,
    manifestPath,
    entries,
    jsFiles,
    files: Array.isArray(manifest.files) ? manifest.files : undefined,
    exists: (rel) => rel !== undefined && existsSync(join(dir, rel)),
    text: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : undefined),
    json: (rel) => {
      const t = existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : undefined;
      if (t === undefined) return undefined;
      try { return JSON.parse(t); } catch { return undefined; }
    },
  };
}

function collect(root, current, out) {
  let names;
  try { names = readdirSync(current, { withFileTypes: true }); } catch { return; }
  for (const dirent of names) {
    const abs = join(current, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      collect(root, abs, out);
      continue;
    }
    if (!/\.(js|mjs|cjs|jsx)$/.test(dirent.name)) continue;
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    if (out.length >= MAX_FILES) return;
    const text = readFileSync(abs, 'utf8');
    const rel = relative(root, abs).split(sep).join('/');
    const { masked, structural, strings, lineStarts } = maskSource(text);
    out.push({ path: rel, text, masked, structural, strings, lineStarts, bytes: size });
  }
}

function firstString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Resolve an exports subpath to a file path, accepting the string and {default} forms. */
export function exportTarget(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return undefined;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : undefined;
  const entry = exportsField[subpath];
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return firstString(entry.default) || firstString(entry.import) || firstString(entry.require);
  return undefined;
}

/**
 * npm packing semantics, simplified: an entry covers a path when it is the same
 * file, a parent directory, or a glob whose pattern matches. \`files\` absent means
 * everything is published.
 */
export function filesCover(files, relPath) {
  if (files === undefined || files.length === 0) return true;
  relPath = String(relPath).replace(/^\.\//, '');
  for (const raw of files) {
    const pattern = String(raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (pattern === '' ) continue;
    if (pattern === relPath) return true;
    if (relPath.startsWith(pattern + '/')) return true;
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern
        .replace(/[.+^$()|[\]{}\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*') + '$');
      if (re.test(relPath)) return true;
    }
  }
  return false;
}
