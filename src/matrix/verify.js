import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { PROBE_VERSION } from '../shared/version.js';
import { readCells, writeCell } from './cells.js';
import { validateCell } from './schema.js';
import { resolveArtifact } from '../probe/artifact-resolver.js';
import { createProbeEnvironment } from '../probe/environment.js';
import { probePackage } from '../probe/probe.js';

export function sampleCells(cells, { sample = 0.2, seed = 1, all = false } = {}) {
  if (all) return [...cells];
  if (sample <= 0) return [];
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return cells.filter(() => next() < Math.min(1, sample));
}

function publicError(error) {
  return { code: error?.code || 'VERIFICATION_FAILED', message: error?.code ? error.message : 'The verification probe could not complete.' };
}

export async function verifyCells({ cells, probe, verifier = { workflow: 'local', runId: 'local', url: '', probeVersion: PROBE_VERSION }, concurrency = 2 }) {
  const report = {
    schemaVersion: 2,
    at: new Date().toISOString(),
    checked: 0,
    confirmed: 0,
    disputed: 0,
    errors: 0,
    cells: [],
    verifier,
  };
  const queue = [...cells];
  async function worker() {
    while (queue.length > 0) {
      const cell = queue.shift();
      const entry = {
        cacheKey: cell.cacheKey,
        plugin: cell.plugin.name,
        dsh: cell.dsh.version,
        composition: cell.dsh.composition,
        reported: { status: cell.result.status },
        verification: verifier,
      };
      try {
        const observation = await probe(cell);
        if (observation.outcome === 'error') {
          entry.verdict = 'error';
          entry.error = observation.error;
          report.errors += 1;
        } else {
          entry.observed = { status: observation.result.status };
          entry.verdict = observation.result.status === cell.result.status ? 'confirmed' : 'disputed';
          if (entry.verdict === 'confirmed') report.confirmed += 1;
          else report.disputed += 1;
        }
      } catch (error) {
        entry.verdict = 'error';
        entry.error = publicError(error);
        report.errors += 1;
      }
      report.cells.push(entry);
      report.checked += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, queue.length)) }, worker));
  return report;
}

export async function verifyMatrix({ cellsDir, sample = 0.2, seed = 1, all = false, concurrency = 2, probe, verifier }) {
  const reads = readCells(cellsDir);
  const damaged = reads.filter((entry) => !entry.ok);
  if (damaged.length > 0) throw new ToolError('VERIFICATION_INPUT_INVALID', `Cannot read ${damaged.length} cell file(s).`);
  const candidates = reads.filter((entry) => entry.kind === 'v2' && entry.cell.run.trust !== 'verified').map((entry) => entry.cell);
  const selected = sampleCells(candidates, { sample, seed, all });
  const report = await verifyCells({ cells: selected, probe, verifier, concurrency });
  report.seed = seed;
  report.sample = sample;
  return report;
}

export function createVerificationProbe({ cacheRoot, backend = 'auto' }) {
  return async (cell) => {
    const artifact = await resolveArtifact({
      name: cell.plugin.name,
      version: cell.plugin.resolvedVersion,
      integrity: cell.plugin.integrity,
      ...(cell.plugin.local ? { path: cell.plugin.path, local: true } : {}),
    });
    const environment = await createProbeEnvironment({ backend, workDir: cacheRoot });
    const dsh = {
      kind: cell.dsh.source === 'desktop' ? 'desktop' : 'npm',
      version: cell.dsh.version,
      source: cell.dsh.source,
      composition: cell.dsh.composition,
    };
    return probePackage({ artifact, dsh, environment, tools: cell.dsh.composition !== 'web', composition: cell.dsh.composition, audit: true });
  };
}

export function applyVerification(cell, reportEntry, { trustedVerifier = false } = {}) {
  if (cell.schemaVersion !== 2) throw new ToolError('CELL_SCHEMA_UNSUPPORTED', 'Only v2 cells can accept verification.');
  if (cell.cacheKey !== reportEntry.cacheKey) throw new ToolError('VERIFICATION_KEY_MISMATCH', 'The verification belongs to a different artifact or composition.');
  if (cell.run.outcome !== 'completed' || reportEntry.reported?.status !== cell.result?.status) {
    throw new ToolError('VERIFICATION_REPORT_MISMATCH', 'The verification does not match the reported observation.');
  }
  if (reportEntry.verdict === 'error') throw new ToolError('VERIFICATION_INCOMPLETE', 'Infrastructure errors are not plugin observations.');
  const updated = structuredClone(cell);
  const verification = reportEntry.verification;
  if (reportEntry.verdict === 'disputed' || reportEntry.observed?.status !== cell.result.status) {
    updated.run.trust = 'disputed';
    updated.run.dispute = { reported: cell.result.status, observed: reportEntry.observed.status };
    updated.run.disputedAt = new Date().toISOString();
    if (verification) updated.run.verification = verification;
  } else if (reportEntry.verdict === 'confirmed') {
    if (trustedVerifier) {
      if (!verification || typeof verification.workflow !== 'string' || !verification.workflow
        || typeof verification.runId !== 'string' || !verification.runId
        || typeof verification.url !== 'string' || !verification.url
        || verification.probeVersion !== cell.probe.version) {
        throw new ToolError('VERIFIER_IDENTITY_INVALID', 'Trusted verification needs complete workflow provenance and a matching probe version.');
      }
      updated.run.trust = 'verified';
      updated.run.verification = verification;
      updated.run.verifiedAt = new Date().toISOString();
      delete updated.run.dispute;
    } else {
      updated.run.trust = cell.run.trust;
    }
  } else {
    throw new ToolError('VERIFICATION_INCOMPLETE', 'The verification has no completed observed status.');
  }
  const validation = validateCell(updated);
  if (!validation.ok) throw new ToolError('CELL_INVALID', validation.errors.join('; '));
  return updated;
}

export async function runVerification({ cellsDir, cacheRoot, sample = 0.2, seed = 1, all = false, concurrency = 2, backend = 'auto', workflow = 'local', runId = 'local', runUrl = '', out }) {
  const probe = createVerificationProbe({ cacheRoot, backend });
  const verifier = { workflow, runId, url: runUrl, probeVersion: PROBE_VERSION };
  const report = await verifyMatrix({ cellsDir, sample, seed, all, concurrency, probe, verifier });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
  return { report, out };
}
