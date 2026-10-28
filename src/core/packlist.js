import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'CVS', '.svn', '.hg']);
const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '(', ')', '|', '{', '}', '\\', '/']);

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function globToRegExp(pattern) {
  const glob = normalizePath(pattern);
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        while (glob[index + 1] === '*') index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '[') {
      const close = glob.indexOf(']', index + 1);
      if (close < 0) throw new Error(`unsupported glob: ${pattern}`);
      let content = glob.slice(index + 1, close);
      if (content.startsWith('!')) content = '^' + content.slice(1);
      source += '[' + content + ']';
      index = close;
      continue;
    }
    source += REGEX_SPECIAL.has(char) ? '\\' + char : char;
  }
  return new RegExp(source + '$');
}

function matches(pattern, relPath) {
  const normalized = normalizePath(pattern);
  if (!normalized) return false;
  if (normalized === relPath || relPath.startsWith(normalized + '/')) return true;
  return normalized.includes('*') || normalized.includes('?') || normalized.includes('[')
    ? globToRegExp(normalized).test(relPath)
    : false;
}

function ruleState(rules, relPath, initial) {
  let state = initial;
  for (const raw of rules) {
    let pattern = String(raw).trim();
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);
    if (matches(pattern, relPath)) state = !negated;
  }
  return state;
}

function intrinsic(relPath, main) {
  if (relPath === 'package.json' || relPath === main) return true;
  return /^(?:readme|license|licence|copying|notice)(?:\.|$)/i.test(relPath);
}

function alwaysIgnored(relPath) {
  const name = basename(relPath);
  return name === '.npmrc'
    || name === '.gitignore'
    || name === '.npmignore'
    || name === '.DS_Store'
    || name === 'npm-debug.log'
    || name === 'yarn-error.log'
    || name === 'package-lock.json'
    || name === 'config.gypi'
    || name === '.lock-wscript'
    || /^\.wafpickle-/.test(name)
    || /^\..*\.swp$/.test(name)
    || name.endsWith('.orig');
}

export function buildPacklist(dir, manifest) {
  const paths = new Set();
  let complete = true;
  if (manifest.files !== undefined && !Array.isArray(manifest.files)) complete = false;
  if ((manifest.bundleDependencies || manifest.bundledDependencies || []).length > 0) complete = false;
  const main = typeof manifest.main === 'string' && manifest.main ? normalizePath(manifest.main) : undefined;
  if (main?.startsWith('../')) complete = false;
  let ignoreRules = [];
  const npmignore = join(dir, '.npmignore');
  if (existsSync(npmignore)) {
    try {
      ignoreRules = readFileSync(npmignore, 'utf8').split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    } catch {
      complete = false;
    }
  }

  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relPath = normalizePath(absolute.slice(dir.length + 1));
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(absolute);
        continue;
      }
      if (!entry.isFile() || alwaysIgnored(relPath)) continue;
      try {
        const included = manifest.files === undefined
          ? true
          : Array.isArray(manifest.files) && ruleState(manifest.files, relPath, false);
        const ignored = ruleState(ignoreRules, relPath, false);
        if (intrinsic(relPath, main) || (included && !ignored)) paths.add(relPath);
      } catch {
        complete = false;
      }
    }
  }

  walk(dir);
  return { paths, complete };
}

export function hasPackedFile(packlist, relPath) {
  return packlist.paths.has(normalizePath(relPath));
}
