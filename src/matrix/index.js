import { ToolError } from '../shared/errors.js';
import { validateCell, validateIndex } from './schema.js';

/**
 * JSON has no `undefined`. A cell that was probed without the tool inventory or
 * without a system prompt would otherwise put `undefined` into the index, and
 * the canonical hash (stableStringify) throws on it — so the artifact could be
 * written but never verified. Drop those keys instead of inventing a value.
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = compact(entry);
    }
    return out;
  }
  return value;
}

export function buildIndex(cells, { generatedAt = new Date().toISOString(), source = {} } = {}) {
  const grouped = new Map();
  const dshVersions = new Set();
  for (const cell of cells) {
    if (cell.run?.outcome !== 'completed' || !validateCell(cell).ok) {
      throw new ToolError('INDEX_INPUT_INVALID', 'Every input cell must be a complete, valid v2 observation.');
    }
    const name = cell.plugin.name;
    const version = cell.plugin.resolvedVersion;
    if (!grouped.has(name)) grouped.set(name, new Map());
    const versions = grouped.get(name);
    if (!versions.has(version)) versions.set(version, []);
    versions.get(version).push(cell);
    dshVersions.add(cell.dsh.version);
  }
  const plugins = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, versions]) => ({
    name,
    versions: [...versions.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([version, entries]) => ({
      version,
      integrity: entries[0].plugin.integrity,
      cells: entries.map((cell) => ({
        cacheKey: cell.cacheKey,
        dsh: cell.dsh.version,
        composition: cell.dsh.composition,
        status: cell.result.status,
        trust: cell.run.trust,
        at: cell.run.at,
        note: cell.evidence?.note,
        awaitedServices: cell.result.awaitedServices,
        toolsAdded: cell.result.tools?.added || [],
        audit: cell.result.audit,
        systemPromptChars: cell.result.systemPrompt?.chars,
        clientHalf: cell.result.clientHalf,
        reproduce: cell.reproduce.command,
      })),
    })),
  }));
  const index = {
    schemaVersion: 2,
    generatedAt,
    source,
    dshVersions: [...dshVersions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    plugins,
    conflicts: source.conflicts || { tools: [], slots: [], routes: [] },
  };
  const clean = compact(index);
  const validation = validateIndex(clean);
  if (!validation.ok) throw new ToolError('INDEX_INPUT_INVALID', validation.errors.join('; '));
  return clean;
}
