import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

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

function readIgnoreFile(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return null;
  }
}

/** npm uses .npmignore in a directory, falling back to .gitignore. */
function ignoreFileIn(dir) {
  const npmignore = join(dir, '.npmignore');
  if (existsSync(npmignore)) return npmignore;
  const gitignore = join(dir, '.gitignore');
  if (existsSync(gitignore)) return gitignore;
  return undefined;
}

export function buildPacklist(dir, manifest) {
  const paths = new Set();
  let complete = true;
  if (manifest.files !== undefined && !Array.isArray(manifest.files)) complete = false;
  if ((manifest.bundleDependencies || manifest.bundledDependencies || []).length > 0) complete = false;
  const main = typeof manifest.main === 'string' && manifest.main ? normalizePath(manifest.main) : undefined;
  if (main?.startsWith('../')) complete = false;

  // npm-packlist disables the ROOT .npmignore/.gitignore as soon as package.json
  // has a `files` array (the array is the complete selection). Nested ignore
  // files still apply, which is why the groups are collected per directory below.
  const hasFiles = Array.isArray(manifest.files);
  const rootGroups = [];
  if (!hasFiles) {
    const rootFile = ignoreFileIn(dir);
    if (rootFile) {
      const rules = readIgnoreFile(rootFile);
      if (rules === null) complete = false;
      else rootGroups.push({ base: dir, rules });
    }
  }

  function walk(current, inherited) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    let groups = inherited;
    if (current !== dir) {
      const nested = ignoreFileIn(current);
      if (nested) {
        const rules = readIgnoreFile(nested);
        if (rules === null) complete = false;
        else groups = [...inherited, { base: current, rules }];
      }
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relPath = normalizePath(relative(dir, absolute));
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(absolute, groups);
        continue;
      }
      if (!entry.isFile() || alwaysIgnored(relPath)) continue;
      try {
        const included = manifest.files === undefined
          ? true
          : Array.isArray(manifest.files) && ruleState(manifest.files, relPath, false);
        let ignored = false;
        for (const group of groups) {
          const rel = normalizePath(relative(group.base, absolute));
          if (rel === '' || rel.startsWith('..')) continue;
          if (ruleState(group.rules, rel, false)) {
            ignored = true;
            break;
          }
        }
        if (intrinsic(relPath, main) || (included && !ignored)) paths.add(relPath);
      } catch {
        complete = false;
      }
    }
  }

  walk(dir, rootGroups);
  return { paths, complete };
}

export function hasPackedFile(packlist, relPath) {
  return packlist.paths.has(normalizePath(relPath));
}
