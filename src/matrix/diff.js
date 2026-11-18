import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { readCells } from './cells.js';

function resolveRunDir(arg) {
  if (typeof arg !== 'string' || !existsSync(arg)) {
    throw new ToolError('DIFF_INPUT_INVALID', 'diff target does not exist: ' + arg);
  }
  const cellsSubdir = join(arg, 'cells');
  return existsSync(cellsSubdir) ? cellsSubdir : arg;
}

function keyOf(cell) {
  if (typeof cell.cacheKey === 'string' && cell.cacheKey) return cell.cacheKey;
  const name = cell.plugin?.name ?? 'unknown';
  const version = cell.plugin?.resolvedVersion ?? '?';
  const dsh = cell.dsh?.version ?? '?';
  const composition = cell.dsh?.composition ?? '?';
  return `${name}@${version}|${dsh}|${composition}`;
}

function indexRun(dir) {
  const map = new Map();
  for (const entry of readCells(dir)) {
    if (!entry.ok || entry.kind === 'run-manifest') continue;
    map.set(keyOf(entry.cell), entry.cell);
  }
  return map;
}

function statusOf(cell) {
  return cell.run?.outcome === 'error' ? 'error' : (cell.result?.status ?? 'unknown');
}

function setDiff(before = [], after = []) {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: [...b].filter((x) => !a.has(x)),
    removed: [...a].filter((x) => !b.has(x)),
  };
}

export function diffRuns(aArg, bArg) {
  const aDir = resolveRunDir(aArg);
  const bDir = resolveRunDir(bArg);
  const aMap = indexRun(aDir);
  const bMap = indexRun(bDir);

  const report = {
    schemaVersion: 1,
    a: aArg,
    b: bArg,
    transitions: [],
    errorTransitions: [],
    newCells: [],
    droppedCells: [],
    toolDeltas: [],
    promptDelta: [],
    notComparable: [],
  };

  for (const [key, bCell] of bMap) {
    if (!aMap.has(key)) { report.newCells.push(key); continue; }
    const aCell = aMap.get(key);
    const aStatus = statusOf(aCell);
    const bStatus = statusOf(bCell);
    const aError = aCell.run?.outcome === 'error';
    const bError = bCell.run?.outcome === 'error';

    if (aError !== bError) {
      report.errorTransitions.push({ key, from: aStatus, to: bStatus });
    } else if (!aError && !bError && aStatus !== bStatus) {
      report.transitions.push({ key, from: aStatus, to: bStatus });
    }

    // tools / prompt deltas only when both runs completed and carry the fields.
    if (!aError && !bError) {
      const aTools = aCell.result?.tools?.added;
      const bTools = bCell.result?.tools?.added;
      if (Array.isArray(aTools) && Array.isArray(bTools)) {
        const delta = setDiff(aTools, bTools);
        if (delta.added.length || delta.removed.length) report.toolDeltas.push({ key, ...delta });
      } else {
        report.notComparable.push({ key, reason: 'no tools data' });
      }
      const aChars = aCell.result?.systemPrompt?.chars;
      const bChars = bCell.result?.systemPrompt?.chars;
      if (Number.isFinite(aChars) && Number.isFinite(bChars)) {
        if (aChars !== bChars) report.promptDelta.push({ key, fromChars: aChars, toChars: bChars });
      } else {
        report.notComparable.push({ key, reason: 'no prompt data' });
      }
    }
  }

  for (const key of aMap.keys()) {
    if (!bMap.has(key)) report.droppedCells.push(key);
  }

  return report;
}

export function formatDiff(report) {
  const regressions = report.transitions.filter((t) => t.from === 'active' && t.to === 'rejected-by-host').length;
  const lines = [];
  lines.push(`matrix diff · ${report.a} -> ${report.b}`);
  lines.push('');
  lines.push(`regressions (active -> rejected-by-host): ${regressions}`);
  lines.push(`status transitions: ${report.transitions.length}`);
  for (const t of report.transitions) lines.push(`  ${t.key}  ${t.from} -> ${t.to}`);
  lines.push(`error transitions: ${report.errorTransitions.length}`);
  for (const t of report.errorTransitions) lines.push(`  ${t.key}  ${t.from} -> ${t.to}`);
  lines.push(`new cells: ${report.newCells.length} · dropped cells: ${report.droppedCells.length}`);
  lines.push(`tool deltas: ${report.toolDeltas.length} · prompt deltas: ${report.promptDelta.length}`);
  if (report.notComparable.length) lines.push(`not comparable: ${report.notComparable.length}`);
  return lines.join('\n');
}
