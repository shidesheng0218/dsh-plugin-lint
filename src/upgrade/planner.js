import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { readCells } from '../matrix/cells.js';
import { recommendationEligible, selectCells } from '../matrix/cell.js';
import { readProfile } from './profile.js';

function readMatrix(matrixDir, targetDsh) {
  if (!existsSync(matrixDir)) throw new ToolError('MATRIX_INPUT_INVALID', 'matrix directory not found: ' + matrixDir);
  const cellsDir = existsSync(join(matrixDir, 'cells')) ? join(matrixDir, 'cells') : matrixDir;
  const reads = readCells(cellsDir);
  const damaged = reads.filter((entry) => !entry.ok);
  if (damaged.length > 0) throw new ToolError('MATRIX_INPUT_INVALID', `cannot read ${damaged.length} matrix cell(s), first: ${damaged[0].path}`);
  const cells = reads.filter((entry) => entry.kind === 'v2' || entry.kind === 'legacy-v1').map((entry) => entry.cell);
  if (cells.length === 0) throw new ToolError('MATRIX_INPUT_INVALID', `no matrix cells found under ${cellsDir} (no data for ${targetDsh})`);
  const dshVersions = [...new Set(cells.map((cell) => cell.dsh.version))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dshVersions.includes(targetDsh)) {
    throw new ToolError('MATRIX_INPUT_INVALID', `the matrix has no cells for DSH ${targetDsh} (it covers: ${dshVersions.join(', ') || 'nothing'})`);
  }
  const byPlugin = new Map();
  for (const cell of cells) {
    if (!byPlugin.has(cell.plugin.name)) byPlugin.set(cell.plugin.name, []);
    byPlugin.get(cell.plugin.name).push(cell);
  }
  return { byPlugin, dshVersions, count: cells.length };
}

function classifyPlugin(plugin, matrix, targetDsh, composition) {
  const base = { name: plugin.name, version: plugin.version ?? null, firstParty: false };
  if (!plugin.version) return { ...base, category: 'unknown', status: 'unknown', reason: 'installed version unknown' };
  const own = matrix.byPlugin.get(plugin.name) || [];
  const testedVersions = [...new Set(own.map((cell) => cell.plugin.resolvedVersion || cell.plugin.version))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const current = own.filter((cell) => (cell.plugin.resolvedVersion || cell.plugin.version) === plugin.version);
  if (current.length === 0) {
    return {
      ...base,
      category: 'unknown',
      status: 'unknown',
      testedVersions,
      reason: own.length === 0
        ? 'plugin is not covered by the matrix'
        : `version ${plugin.version} is not covered for DSH ${targetDsh} (tested versions: ${testedVersions.join(', ')})`,
    };
  }
  const selection = selectCells(current, { dshVersion: targetDsh, composition });
  if (selection.kind !== 'cells') {
    return {
      ...base,
      category: selection.kind,
      status: selection.kind,
      testedVersions,
      reason: selection.kind === 'mixed'
        ? 'multiple compositions are present but the current profile composition is unknown'
        : selection.kind === 'unknown'
          ? 'the current profile composition or trust evidence is unknown'
          : 'no exact cell exists for the installed version, target DSH, and composition',
    };
  }

  const statuses = new Set(selection.cells.map((cell) => cell.result.status));
  const allActiveAndEligible = selection.cells.every((cell) => cell.result.status === 'active' && recommendationEligible(cell));
  if (allActiveAndEligible) return { ...base, category: 'compatible', status: 'active', composition };
  if (statuses.size > 1) return { ...base, category: 'mixed', status: 'mixed', testedVersions, reason: 'observations disagree within the selected composition' };

  const currentStatus = selection.cells[0].result.status;
  const alternatives = testedVersions.filter((version) => version !== plugin.version).filter((version) => {
    const candidate = selectCells(own.filter((cell) => (cell.plugin.resolvedVersion || cell.plugin.version) === version), { dshVersion: targetDsh, composition });
    return candidate.kind === 'cells' && candidate.cells.every((cell) => cell.result.status === 'active' && recommendationEligible(cell));
  }).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const negative = !['active', 'awaiting-service'].includes(currentStatus);
  if (alternatives.length > 0 && negative) {
    return { ...base, category: 'needsUpdate', status: currentStatus, composition, recommendedVersion: alternatives[0], reason: `version ${alternatives[0]} has verified active evidence on the same DSH and composition` };
  }
  if (negative) {
    return { ...base, category: 'noCompatibleVersion', status: currentStatus, composition, testedVersions, reason: 'no verified active version exists for this DSH and composition' };
  }
  return { ...base, category: 'untested', status: currentStatus, composition, testedVersions, reason: 'active evidence is missing, self-reported, legacy, stale, or composition-incomplete' };
}

export async function planUpgrade({ profileDir, matrixDir, from, to, composition }) {
  if (composition !== undefined && !['headless', 'web'].includes(composition)) throw new ToolError('MATRIX_INPUT_INVALID', 'composition must be headless or web');
  const profile = readProfile(profileDir);
  const matrix = readMatrix(matrixDir, to);
  const selectedComposition = composition || profile.composition;
  const categories = { compatible: [], untested: [], needsUpdate: [], noCompatibleVersion: [], unknown: [], mixed: [], firstParty: [] };
  for (const plugin of profile.plugins) {
    if (plugin.firstParty) {
      categories.firstParty.push({ name: plugin.name, version: plugin.version ?? null, firstParty: true, category: 'firstParty', status: 'not-covered', reason: 'first-party bundle; the community matrix does not cover it' });
      continue;
    }
    const classified = classifyPlugin(plugin, matrix, to, selectedComposition);
    categories[classified.category].push(classified);
  }
  const installTargets = categories.needsUpdate.filter((plugin) => plugin.recommendedVersion).map((plugin) => `${plugin.name}@${plugin.recommendedVersion}`);
  const summary = {
    total: profile.plugins.length,
    community: profile.plugins.length - categories.firstParty.length,
    compatible: categories.compatible.length,
    untested: categories.untested.length,
    needsUpdate: categories.needsUpdate.length,
    noCompatibleVersion: categories.noCompatibleVersion.length,
    unknown: categories.unknown.length,
    mixed: categories.mixed.length,
    firstParty: categories.firstParty.length,
    needAction: categories.needsUpdate.length + categories.noCompatibleVersion.length,
  };
  return {
    schemaVersion: 2,
    mode: 'upgrade-plan',
    from,
    to,
    composition: selectedComposition || null,
    profile: { path: profile.path, source: profile.source, bundles: profile.plugins.length, composition: profile.composition || null },
    matrix: { dir: matrixDir, cells: matrix.count, dshVersions: matrix.dshVersions },
    categories,
    summary,
    installCommand: installTargets.length ? 'npm install ' + installTargets.join(' ') : null,
  };
}
