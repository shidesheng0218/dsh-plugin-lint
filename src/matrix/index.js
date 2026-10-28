import { ToolError } from '../shared/errors.js';
import { validateCell, validateIndex } from './schema.js';

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
  const validation = validateIndex(index);
  if (!validation.ok) throw new ToolError('INDEX_INPUT_INVALID', validation.errors.join('; '));
  return index;
}
