import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { detectConflicts } from '../experimental/conflicts.js';
import { loadPackage } from '../core/load.js';
import { ToolError } from '../shared/errors.js';
import { downloadArtifact, resolveArtifact } from '../probe/artifact-resolver.js';
import { createProbeEnvironment } from '../probe/environment.js';
import { resolveDsh, safeEnv } from '../probe/dsh-adapter.js';
import { readInstalledArtifact } from '../probe/installed-artifact.js';
import { classify } from '../probe/classify.js';
import { parseInactive, payloadOf } from '../probe/probe.js';

const execFileAsync = promisify(execFile);

function safeName(value) {
  return String(value).replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function artifactFromCell(cell) {
  return {
    name: cell.plugin.name,
    requestedVersion: cell.plugin.resolvedVersion,
    resolvedVersion: cell.plugin.resolvedVersion,
    integrity: cell.plugin.integrity,
    sourceDigest: cell.plugin.sourceDigest,
    local: cell.plugin.local,
    path: cell.plugin.path,
    tarballUrl: cell.plugin.tarballUrl,
    installTarget: `${cell.plugin.name}@${cell.plugin.resolvedVersion}`,
  };
}

function uniqueArtifacts(cells) {
  const artifacts = new Map();
  for (const cell of cells) {
    const artifact = artifactFromCell(cell);
    const key = `${artifact.name}@${artifact.resolvedVersion}@${artifact.integrity || artifact.sourceDigest}`;
    if (!artifacts.has(key)) artifacts.set(key, { artifact, cells: [] });
    artifacts.get(key).cells.push(cell);
  }
  return [...artifacts.values()];
}

function assertSafeTarEntry(path) {
  if (path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../') || path.includes('\0')) {
    throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', 'The artifact contains an unsafe archive path.');
  }
}

function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', 'The artifact contains a symbolic link.');
    if (entry.isDirectory()) assertNoSymlinks(join(dir, entry.name));
  }
}

export function createPinnedMaterializer({ cacheRoot }) {
  return async (artifact) => {
    if (artifact.local && artifact.path) return artifact.path;
    const pinned = await resolveArtifact({ name: artifact.name, version: artifact.resolvedVersion, integrity: artifact.integrity });
    const downloaded = await downloadArtifact(pinned);
    const destination = join(cacheRoot, 'pkgs', safeName(artifact.name), safeName(artifact.resolvedVersion));
    if (existsSync(join(destination, 'package.json'))) return destination;
    mkdirSync(cacheRoot, { recursive: true });
    const listing = await execFileAsync('tar', ['-tzf', downloaded.tarballPath], { env: safeEnv(), maxBuffer: 16 * 1024 * 1024 });
    for (const path of listing.stdout.split('\n').filter(Boolean)) assertSafeTarEntry(path);
    const temporary = mkdtempSync(join(cacheRoot, 'extract-'));
    try {
      await execFileAsync('tar', ['-xzf', downloaded.tarballPath, '-C', temporary, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], { env: safeEnv(), maxBuffer: 16 * 1024 * 1024 });
      assertNoSymlinks(temporary);
      if (!existsSync(join(temporary, 'package.json'))) throw new ToolError('ARTIFACT_MISSING', 'The extracted artifact has no package.json.');
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(join(destination, '..'), { recursive: true });
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    return destination;
  };
}

async function verifyPinnedCombo({ artifacts, directories, dshVersion }) {
  const environment = await createProbeEnvironment({ backend: 'auto' });
  let stub;
  try {
    const dsh = await resolveDsh(dshVersion, environment.dshDir, { environment });
    stub = await environment.startStub();
    const patchPath = environment.isolation === 'docker' ? '/profile/probe-patch.yml' : join(environment.profileDir, 'probe-patch.yml');
    writeFileSync(join(environment.profileDir, 'probe-patch.yml'), [
      '- id: llm-deepseek',
      '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
      '  config:',
      `    baseURL: ${stub.baseURL}`,
      '    apiKeyEnv: PROBE_API_KEY',
      '',
    ].join('\n'));
    const bootInput = {
      dsh,
      args: ['--profile', 'headless', '--patch', patchPath, 'probe'],
      env: { PROBE_API_KEY: 'probe' },
      network: stub.network,
    };
    await environment.boot(bootInput);
    await stub.sync();
    const before = payloadOf(stub.seen.splice(0));
    for (const artifact of artifacts) {
      const directory = directories.get(artifact.name);
      const materialized = await environment.materialize({ ...artifact, local: true, path: directory });
      await environment.install({ dsh, target: materialized, profile: 'headless', env: { PROBE_API_KEY: 'probe' } });
      const installed = readInstalledArtifact(join(environment.profileDir, 'profiles', 'headless'), artifact.name);
      if (installed.version !== artifact.resolvedVersion) throw new ToolError('VERSION_MISMATCH', 'A combination installed a different artifact version.');
    }
    const booted = await environment.boot(bootInput);
    await stub.sync();
    const after = payloadOf(stub.seen.splice(0));
    const entries = parseInactive(booted.out);
    const beforeNames = new Set(before?.tools?.map((tool) => tool.name) || []);
    const afterNames = new Set(after?.tools?.map((tool) => tool.name) || []);
    return {
      status: classify(booted.out, entries, Boolean(after)),
      trust: 'self-reported',
      entries,
      dropped: [...beforeNames].filter((name) => !afterNames.has(name)),
      beforeCount: beforeNames.size,
      afterCount: afterNames.size,
    };
  } finally {
    if (stub?.server) stub.server.close();
    await environment.destroy();
  }
}

function candidateTools(cells) {
  const owners = new Map();
  for (const cell of cells) {
    for (const tool of cell.result.tools?.added || []) {
      if (!owners.has(tool)) owners.set(tool, new Map());
      owners.get(tool).set(`${cell.plugin.name}@${cell.plugin.resolvedVersion}`, cell);
    }
  }
  return [...owners.entries()].filter(([, byPlugin]) => byPlugin.size > 1).map(([resource, byPlugin]) => {
    const claims = [...byPlugin.values()];
    return {
      resource,
      plugins: claims.map((cell) => cell.plugin.name),
      cells: claims,
      status: 'candidate',
    };
  });
}

export async function scanConflicts({ cells, materialize, verify = false, verifyCombo = verifyPinnedCombo, limit = Number.POSITIVE_INFINITY }) {
  const errors = [];
  const unique = uniqueArtifacts(cells);
  const packages = [];
  const directories = new Map();
  const pluginsScanned = [];
  for (const entry of unique) {
    try {
      const directory = await materialize(entry.artifact);
      directories.set(entry.artifact.name, directory);
      packages.push(loadPackage(directory));
      pluginsScanned.push(entry.artifact.name);
    } catch (error) {
      errors.push({ code: error.code || 'ARTIFACT_MATERIALIZE_FAILED', plugin: entry.artifact.name, message: error.message });
    }
  }
  const staticReport = detectConflicts(packages);
  const tools = candidateTools(cells);
  const slots = staticReport.slots.map((entry) => ({ ...entry, status: 'candidate' }));
  const routes = staticReport.routes.map((entry) => ({ ...entry, status: 'candidate' }));
  const verified = { tools: [], slots: [], routes: [] };
  if (verify) {
    for (const [kind, candidates] of [['tools', tools], ['slots', slots], ['routes', routes]]) {
      for (const candidate of candidates.slice(0, limit)) {
        try {
          const names = new Set(candidate.plugins);
          const artifacts = unique.filter((entry) => names.has(entry.artifact.name)).map((entry) => entry.artifact);
          const relatedCells = candidate.cells || unique.filter((entry) => names.has(entry.artifact.name)).flatMap((entry) => entry.cells);
          const result = await verifyCombo({
            kind,
            candidate,
            artifacts,
            directories,
            dshVersion: relatedCells[0]?.dsh.version,
            composition: relatedCells[0]?.dsh.composition,
          });
          verified[kind].push({ resource: candidate.resource, plugins: candidate.plugins, ...result });
        } catch (error) {
          errors.push({ code: error.code || 'CONFLICT_VERIFICATION_FAILED', resource: candidate.resource, message: error.message });
        }
      }
    }
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    cells: cells.length,
    pluginsScanned,
    tools,
    slots,
    routes,
    unknownRoutes: staticReport.unknownRoutes,
    verified,
    errors,
  };
}
