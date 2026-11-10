import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { PROBE_VERSION } from '../shared/version.js';
import { sha256 } from '../shared/hash.js';
import { resolveArtifact } from '../probe/artifact-resolver.js';
import { createProbeEnvironment } from '../probe/environment.js';
import { probePackage } from '../probe/probe.js';
import { startStub as startHostStub } from '../probe/dsh-adapter.js';
import { cacheKeyFor } from './cache.js';
import { createCell } from './cell.js';
import { cellFilePath, writeCell } from './cells.js';
import { readCellAny } from './migrate.js';
import { buildManifest } from './manifest.js';
import { validateCell } from './schema.js';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const productionServices = {
  resolveArtifact,
  createProbeEnvironment,
  probePackage,
  startStub: async ({ environment }) => environment.startStub ? environment.startStub() : startHostStub(),
};

function splitSpec(value) {
  const text = String(value);
  const split = text.startsWith('@') ? text.lastIndexOf('@') > text.indexOf('/') : text.lastIndexOf('@') > 0;
  if (!split) return { name: text, version: 'latest' };
  const index = text.lastIndexOf('@');
  return { name: text.slice(0, index), version: text.slice(index + 1) || 'latest' };
}

function inputFor(target, targetMode) {
  if (targetMode === 'refresh-latest') {
    if (typeof target === 'string' && existsSync(target)) return target;
    if (target && typeof target === 'object' && (target.local || target.path)) return target;
    return typeof target === 'string' ? splitSpec(target).name : target.name;
  }
  if ((typeof target === 'string' && existsSync(target)) || (target && typeof target === 'object' && (target.local || target.path))) return target;
  if (target && typeof target === 'object') {
    if (!EXACT_VERSION.test(target.version || '') || typeof target.integrity !== 'string') {
      throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', 'Pinned matrix targets need an exact version and registry integrity.');
    }
    return target;
  }
  const spec = splitSpec(target);
  if (!EXACT_VERSION.test(spec.version)) {
    throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', 'Pinned matrix targets cannot re-resolve latest or a dist-tag.');
  }
  return target;
}

function publicError(error) {
  return {
    code: error?.code || 'MATRIX_INFRASTRUCTURE_ERROR',
    message: error?.code ? error.message : 'The matrix cell could not complete because of an internal or host failure.',
  };
}

export async function runMatrix({
  targets,
  targetMode = 'pinned',
  dshVersions,
  compositions = ['headless', 'web'],
  outDir,
  cacheRoot,
  concurrency = 4,
  force = false,
  keep = false,
  useTools = true,
  backend = 'auto',
  services = productionServices,
  runId = 'local-matrix',
}) {
  if (!['pinned', 'refresh-latest'].includes(targetMode)) throw new ToolError('MATRIX_INPUT_INVALID', 'targetMode must be pinned or refresh-latest.');
  if (!Array.isArray(targets) || targets.length === 0) throw new ToolError('MATRIX_INPUT_INVALID', 'At least one target is required.');
  if (!Array.isArray(dshVersions) || dshVersions.length === 0) throw new ToolError('MATRIX_INPUT_INVALID', 'At least one DSH version is required.');
  if (!Array.isArray(compositions) || compositions.length === 0 || compositions.some((mode) => !['headless', 'web'].includes(mode))) {
    throw new ToolError('MATRIX_INPUT_INVALID', 'compositions must contain only headless and/or web.');
  }
  if (!outDir || !cacheRoot) throw new ToolError('MATRIX_INPUT_INVALID', 'outDir and cacheRoot are required.');
  const resolved = [];
  for (const target of targets) {
    const artifact = await services.resolveArtifact(inputFor(target, targetMode));
    resolved.push({
      artifact,
      input: {
        name: artifact.name,
        requestedVersion: artifact.requestedVersion,
        resolvedVersion: artifact.resolvedVersion,
        // A local artifact has integrity: undefined. JSON has no undefined, and
        // stableStringify rightly rejects it; omitting the key keeps the manifest
        // hashable instead of aborting every local-directory run.
        ...(artifact.integrity !== undefined ? { integrity: artifact.integrity } : {}),
        ...(artifact.sourceDigest !== undefined ? { sourceDigest: artifact.sourceDigest } : {}),
        local: artifact.local,
      },
    });
  }
  const tasks = [];
  for (const { artifact } of resolved) {
    for (const version of dshVersions) {
      for (const composition of compositions) tasks.push({ artifact, version, composition });
    }
  }
  const summary = {
    total: tasks.length,
    completed: 0,
    errors: 0,
    cached: 0,
    invalidCache: 0,
    targetMode,
    inputs: resolved.map((entry) => entry.input),
    statuses: {},
    outDir,
    cacheRoot,
  };
  const written = [];
  let invalidCache = 0;

  function cachedCell(task, cacheKey) {
    if (force) return undefined;
    const path = cellFilePath(cacheRoot, {
      plugin: task.artifact,
      dsh: { version: task.version, composition: task.composition },
      cacheKey,
    });
    if (!existsSync(path)) return undefined;
    try {
      const { kind, cell } = readCellAny(JSON.parse(readFileSync(path, 'utf8')));
      if (kind !== 'v2' || cell.cacheKey !== cacheKey || cell.run.outcome !== 'completed' || !validateCell(cell).ok) {
        invalidCache += 1;
        return undefined;
      }
      writeCell(outDir, cell);
      return { cell, path: cellFilePath(outDir, cell), cached: true };
    } catch {
      invalidCache += 1;
      return undefined;
    }
  }

  async function execute(task) {
    const cacheKey = cacheKeyFor({ artifact: task.artifact, dshVersion: task.version, composition: task.composition, probeVersion: PROBE_VERSION });
    const cached = cachedCell(task, cacheKey);
    if (cached) return cached;
    let environment;
    let stub;
    let observation;
    try {
      environment = await services.createProbeEnvironment({
        backend,
        workDir: cacheRoot,
        dshDir: task.version !== 'desktop' ? join(cacheRoot, 'dsh', task.version) : undefined,
      });
      stub = useTools && task.composition !== 'web' ? await services.startStub({ environment, composition: task.composition }) : undefined;
      const dsh = { kind: task.version === 'desktop' ? 'desktop' : 'npm', version: task.version, source: task.version === 'desktop' ? 'desktop' : 'npm', composition: task.composition };
      observation = await services.probePackage({ artifact: task.artifact, dsh, environment, stub, tools: useTools, keep, composition: task.composition, audit: true });
    } catch (error) {
      observation = { outcome: 'error', error: publicError(error), entries: [], durationMs: 0 };
      if (environment) await environment.destroy();
    } finally {
      if (stub?.server) stub.server.close();
    }
    let cell;
    try {
      cell = createCell({
        artifact: task.artifact,
        dsh: { version: task.version, source: task.version === 'desktop' ? 'desktop' : 'npm', composition: task.composition },
        observation,
        isolation: environment?.isolation || backend,
        probeVersion: PROBE_VERSION,
      });
    } catch (error) {
      // A cell that cannot be represented is an infrastructure error for that
      // cell, not a reason to abort the remaining queue.
      cell = createCell({
        artifact: task.artifact,
        dsh: { version: task.version, source: task.version === 'desktop' ? 'desktop' : 'npm', composition: task.composition },
        observation: {
          outcome: 'error',
          error: { code: 'CELL_BUILD_FAILED', message: String(error?.message || error) },
          entries: [],
          durationMs: observation?.durationMs || 0,
        },
        isolation: environment?.isolation || backend,
        probeVersion: PROBE_VERSION,
      });
    }
    const path = writeCell(outDir, cell);
    if (cell.run.outcome === 'completed' && cacheRoot !== outDir) writeCell(cacheRoot, cell);
    return { cell, path, cached: false };
  }

  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length > 0) {
      const result = await execute(queue.shift());
      written.push(result);
    }
  });
  await Promise.all(workers);
  written.sort((a, b) => a.cell.plugin.name.localeCompare(b.cell.plugin.name)
    || a.cell.plugin.resolvedVersion.localeCompare(b.cell.plugin.resolvedVersion, undefined, { numeric: true })
    || a.cell.dsh.version.localeCompare(b.cell.dsh.version, undefined, { numeric: true })
    || a.cell.dsh.composition.localeCompare(b.cell.dsh.composition));

  for (const { cell, cached } of written) {
    if (cached) summary.cached += 1;
    if (cell.run.outcome === 'completed') {
      summary.completed += 1;
      summary.statuses[cell.result.status] = (summary.statuses[cell.result.status] || 0) + 1;
    } else {
      summary.errors += 1;
    }
  }
  summary.invalidCache = invalidCache;
  const manifest = buildManifest({
    runId,
    probeVersion: PROBE_VERSION,
    inputs: {
      targetMode,
      targets: summary.inputs,
      dshVersions,
      compositions,
      probeVersion: PROBE_VERSION,
    },
    artifacts: written.map(({ path }) => {
      const bytes = readFileSync(path);
      return { path: relative(outDir, path).replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256(bytes) };
    }),
  });
  manifest.targetMode = targetMode;
  manifest.inputs = summary.inputs;
  manifest.cellCount = written.length;
  manifest.errorCount = summary.errors;
  const manifestPath = `${outDir}/run-manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  summary.manifestPath = manifestPath;
  return { cells: written.map((entry) => entry.cell), summary };
}
