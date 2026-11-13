import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Files changed against `ref` (default HEAD) or staged in the index. */
export function changedFiles({ cwd = process.cwd(), ref, staged = false } = {}) {
  const args = ['diff', '--name-only', '--diff-filter=ACMR'];
  if (staged) args.push('--cached');
  args.push(ref || 'HEAD');
  const output = execFileSync('git', args, { cwd, encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Map changed files to the nearest enclosing package.json. Deleted files map
 * to their former directory; files outside any package are ignored.
 */
export function packageRoots(files, cwd = process.cwd()) {
  const base = resolve(cwd);
  const roots = new Set();
  for (const file of files) {
    let dir = resolve(base, file);
    try {
      if (!statSync(dir).isDirectory()) dir = dirname(dir);
    } catch {
      dir = dirname(dir);
    }
    while (true) {
      const rel = relative(base, dir);
      if (rel.startsWith('..') || isAbsolute(rel)) break;
      if (existsSync(join(dir, 'package.json'))) {
        roots.add(dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...roots].sort();
}