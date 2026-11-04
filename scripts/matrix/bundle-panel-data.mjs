#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPublicArtifact } from '../../src/matrix/export.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function legacyAggregate(index) {
  const aggregate = {
    schemaVersion: 2,
    generatedAt: index.generatedAt,
    sourceRunId: index.source?.runId || index.sourceRunId,
    dshVersions: index.dshVersions || [],
    plugins: index.plugins.length,
    versions: {},
  };
  for (const plugin of index.plugins) {
    const versions = Array.isArray(plugin.versions) ? plugin.versions : [plugin];
    for (const version of versions) {
      for (const cell of version.cells || []) {
        if (!aggregate.versions[cell.dsh]) aggregate.versions[cell.dsh] = {};
        const tally = aggregate.versions[cell.dsh];
        tally[cell.status] = (tally[cell.status] || 0) + 1;
      }
    }
  }
  return aggregate;
}

export async function bundlePanelData({ root = ROOT, bundledAt = new Date().toISOString() } = {}) {
  const publicDir = join(root, 'matrix/public');
  const publicIndex = join(publicDir, 'index/latest.json');
  const usePublic = existsSync(publicIndex);
  const indexPath = usePublic ? publicIndex : join(root, 'matrix/index/latest.json');
  if (!usePublic && !existsSync(indexPath)) {
    throw new Error('No public artifact or legacy index found; run scripts/matrix/export.mjs first.');
  }
  if (usePublic) {
    const verification = await verifyPublicArtifact({ dir: publicDir });
    if (!verification.ok) throw new Error('Invalid public matrix artifact: ' + verification.errors.join('; '));
  }
  const index = readJson(indexPath);
  const aggregate = usePublic ? readJson(join(publicDir, 'aggregate.json')) : legacyAggregate(index);
  const snapshot = {
    ...index,
    snapshot: {
      bundledAt,
      source: relative(root, indexPath).replace(/\\/g, '/'),
    },
  };
  const dataDir = join(root, 'panel/data');
  const fullPath = join(dataDir, 'matrix-index.json');
  const aggregatePath = join(dataDir, 'aggregate.json');
  writeJson(fullPath, snapshot);
  writeJson(aggregatePath, aggregate);
  return { fullPath, aggregatePath, aggregate };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await bundlePanelData();
    console.log(`bundled ${result.aggregate.plugins} plugins into ${result.fullPath}`);
    console.log(`aggregate (no package names) written to ${result.aggregatePath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
