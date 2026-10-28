#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportPublicArtifact, verifyPublicArtifact } from '../../src/matrix/export.js';
import { applyVerification } from '../../src/matrix/verify.js';
import { readCells, writeCell } from '../../src/matrix/cells.js';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('Usage: node scripts/matrix/verify-public.mjs --source <dir> [--verification <report.json>]');
  process.exit(0);
}
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const source = argOf('--source');
if (!source) {
  console.error('verify-public: --source is required');
  process.exit(2);
}

try {
  if (!existsSync(join(source, 'manifest.json')) || !existsSync(join(source, 'aggregate.json'))) {
    const runManifestPath = join(source, 'cells', 'run-manifest.json');
    const runManifest = existsSync(runManifestPath) ? JSON.parse(readFileSync(runManifestPath, 'utf8')) : undefined;
    await exportPublicArtifact({
      cellsDir: join(source, 'cells'),
      conflictsPath: join(source, 'index', 'conflicts.json'),
      outDir: source,
      runId: runManifest?.runId || argOf('--run-id', 'local-matrix'),
      expectedCells: runManifest?.cellCount,
    });
  }
  const verificationPath = argOf('--verification');
  if (verificationPath) {
    const report = JSON.parse(readFileSync(verificationPath, 'utf8'));
    const reads = readCells(join(source, 'cells'));
    const byKey = new Map(reads.filter((entry) => entry.kind === 'v2').map((entry) => [entry.cell.cacheKey, entry.cell]));
    for (const entry of report.cells || []) {
      const cell = byKey.get(entry.cacheKey);
      if (!cell) throw new Error(`verification references an unknown cache key: ${entry.cacheKey}`);
      writeCell(join(source, 'cells'), applyVerification(cell, entry, { trustedVerifier: true }));
    }
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
    await exportPublicArtifact({
      cellsDir: join(source, 'cells'),
      conflictsPath: join(source, 'index', 'conflicts.json'),
      outDir: source,
      runId: manifest.runId,
      expectedCells: manifest.cellCount,
    });
  }
  const verification = await verifyPublicArtifact({ dir: source });
  console.log(JSON.stringify(verification, null, 2));
  process.exitCode = verification.ok ? 0 : 2;
} catch (error) {
  console.error(`${error.code || 'PUBLIC_VERIFICATION_FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
