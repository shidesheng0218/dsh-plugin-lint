import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { PROBE_VERSION } from '../shared/version.js';
import { stableStringify, sha256 } from '../shared/hash.js';
import { readCells, writeCell } from './cells.js';
import { buildIndex } from './index.js';
import { buildManifest } from './manifest.js';
import { validateCell, validateIndex, validateManifest } from './schema.js';
import { sanitizeCellForPublish, sanitizeForPublish } from './sanitize.js';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function filesUnder(dir) {
  const files = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(dir, path).replace(/\\/g, '/'));
    }
  }
  walk(dir);
  return files.sort();
}

function buildAggregate(index, sourceRunId) {
  const aggregate = {
    schemaVersion: 2,
    generatedAt: index.generatedAt,
    sourceRunId,
    dshVersions: index.dshVersions,
    plugins: index.plugins.length,
    versions: {},
  };
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      for (const cell of version.cells) {
        if (!aggregate.versions[cell.dsh]) aggregate.versions[cell.dsh] = {};
        aggregate.versions[cell.dsh][cell.status] = (aggregate.versions[cell.dsh][cell.status] || 0) + 1;
      }
    }
  }
  return aggregate;
}

export async function exportPublicArtifact({ cellsDir, conflictsPath, outDir, runId, generatedAt = new Date().toISOString(), expectedCells }) {
  const reads = readCells(cellsDir);
  const invalid = reads.filter((entry) => !entry.ok);
  if (invalid.length > 0) throw new ToolError('EXPORT_INPUT_INVALID', `Cannot read ${invalid.length} cell file(s).`);
  if (reads.some((entry) => entry.kind === 'legacy-v1')) throw new ToolError('EXPORT_INPUT_INVALID', 'Legacy cells cannot be republished as v2 evidence.');
  const cells = reads.filter((entry) => entry.kind === 'v2').map((entry) => sanitizeCellForPublish(entry.cell));
  if (expectedCells !== undefined && cells.length !== expectedCells) {
    throw new ToolError('EXPORT_CELL_COUNT_MISMATCH', `Expected ${expectedCells} cells, found ${cells.length}.`);
  }
  if (!runId) throw new ToolError('EXPORT_INPUT_INVALID', 'runId is required.');
  if (!existsSync(conflictsPath)) throw new ToolError('EXPORT_INPUT_INVALID', 'The computed conflicts artifact is required.');
  const conflicts = sanitizeForPublish(readJson(conflictsPath));
  if (conflicts.schemaVersion !== 2) throw new ToolError('EXPORT_INPUT_INVALID', 'Conflicts must use schema v2.');
  const index = buildIndex(cells, { generatedAt, source: { runId, conflicts } });
  const aggregate = buildAggregate(index, runId);
  const sourceManifest = reads.find((entry) => entry.kind === 'run-manifest')?.manifest;
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.export-'));
  try {
    for (const cell of cells) writeCell(join(staging, 'cells'), cell);
    writeJson(join(staging, 'index', 'latest.json'), index);
    writeJson(join(staging, 'index', 'conflicts.json'), conflicts);
    writeJson(join(staging, 'aggregate.json'), aggregate);
    const artifacts = filesUnder(staging).map((path) => {
      const bytes = readFileSync(join(staging, path));
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    });
    const manifest = buildManifest({
      runId,
      generatedAt,
      probeVersion: PROBE_VERSION,
      inputs: { targetMode: sourceManifest?.targetMode || 'pinned', expectedCells: expectedCells ?? cells.length, inputs: sourceManifest?.inputs || index.plugins.map((plugin) => plugin.name) },
      artifacts,
    });
    manifest.targetMode = sourceManifest?.targetMode || 'pinned';
    manifest.inputs = sourceManifest?.inputs || index.plugins.map((plugin) => plugin.name);
    manifest.cellCount = cells.length;
    if (expectedCells !== undefined) manifest.expectedCells = expectedCells;
    writeJson(join(staging, 'manifest.json'), manifest);
    const verification = await verifyPublicArtifact({ dir: staging });
    if (!verification.ok) throw new ToolError('EXPORT_INPUT_INVALID', verification.errors.join('; '));
    const backup = `${outDir}.backup-${Date.now()}`;
    if (existsSync(outDir)) renameSync(outDir, backup);
    try {
      renameSync(staging, outDir);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, outDir);
      throw error;
    }
    return { manifest, filesWritten: artifacts.length + 1, cells: cells.length };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPublicArtifact({ dir }) {
  const errors = [];
  try {
    const manifest = readJson(join(dir, 'manifest.json'));
    const manifestValidation = validateManifest(manifest);
    if (!manifestValidation.ok) errors.push(...manifestValidation.errors);
    const declared = new Set(manifest.artifacts.map((artifact) => artifact.path));
    const actual = new Set(filesUnder(dir).filter((path) => path !== 'manifest.json'));
    for (const path of declared) {
      if (!actual.has(path)) {
        errors.push(`artifact is missing: ${path}`);
        continue;
      }
      const expected = manifest.artifacts.find((artifact) => artifact.path === path);
      const bytes = readFileSync(join(dir, path));
      if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) errors.push(`artifact hash mismatch: ${path}`);
    }
    for (const path of actual) if (!declared.has(path)) errors.push(`undeclared artifact: ${path}`);

    const index = readJson(join(dir, 'index', 'latest.json'));
    const indexValidation = validateIndex(index);
    if (!indexValidation.ok) errors.push(...indexValidation.errors);
    const conflicts = readJson(join(dir, 'index', 'conflicts.json'));
    if (conflicts.schemaVersion !== 2) errors.push('conflicts.schemaVersion must be 2');
    const reads = readCells(join(dir, 'cells'));
    const invalid = reads.filter((entry) => !entry.ok);
    if (invalid.length > 0) errors.push(`${invalid.length} damaged public cell(s)`);
    const cells = reads.filter((entry) => entry.kind === 'v2').map((entry) => entry.cell);
    for (const cell of cells) {
      const validation = validateCell(cell);
      if (!validation.ok) errors.push(...validation.errors);
    }
    if (manifest.cellCount !== cells.length) errors.push(`cell count mismatch: manifest ${manifest.cellCount}, actual ${cells.length}`);
    if (manifest.expectedCells !== undefined && manifest.expectedCells !== cells.length) errors.push(`expected cell count mismatch: ${manifest.expectedCells} vs ${cells.length}`);
    const expectedIndex = buildIndex(cells, { generatedAt: index.generatedAt, source: index.source });
    if (stableStringify(expectedIndex) !== stableStringify(index)) errors.push('index does not match the public cells');
    const expectedAggregate = buildAggregate(index, manifest.runId);
    const aggregate = readJson(join(dir, 'aggregate.json'));
    if (stableStringify(expectedAggregate) !== stableStringify(aggregate)) errors.push('aggregate does not match the index');
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors };
}
