import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { readCellAny } from './migrate.js';
import { validateCell } from './schema.js';

function segment(value) {
  return String(value).replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function cellFilePath(outDir, cell) {
  return join(
    outDir,
    segment(cell.plugin.name),
    segment(cell.plugin.resolvedVersion),
    `${segment(cell.dsh.version)}+${segment(cell.dsh.composition)}.${cell.cacheKey.slice(0, 16)}.json`,
  );
}

export function writeCell(outDir, cell) {
  if (cell.schemaVersion !== 2) throw new ToolError('CELL_SCHEMA_UNSUPPORTED', 'Only v2 cells can be written by the matrix runner.');
  if (cell.run.outcome === 'completed') {
    const validation = validateCell(cell);
    if (!validation.ok) throw new ToolError('CELL_INVALID', validation.errors.join('; '));
  }
  const path = cellFilePath(outDir, cell);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cell, null, 2) + '\n');
  return path;
}

export function readCells(dir) {
  if (!existsSync(dir)) throw new ToolError('CELL_READ_FAILED', `The cells directory does not exist: ${dir}`);
  const results = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (entry.name === 'run-manifest.json') {
          results.push({ ok: true, path, kind: 'run-manifest', manifest: value });
          continue;
        }
        const { kind, cell } = readCellAny(value);
        results.push({ ok: true, path, kind, cell });
      } catch (error) {
        results.push({ ok: false, path, error: { code: error.code || 'CELL_INVALID', message: error.message } });
      }
    }
  }
  walk(dir);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}
