import { isPlainObject } from '../shared/validate.js';
import { cacheKeyFor } from './cache.js';

const HEX64 = /^[0-9a-f]{64}$/;
const TRUST = new Set(['self-reported', 'verified', 'disputed']);
const OUTCOME = new Set(['completed', 'error']);

function object(value, path, errors) {
  if (!isPlainObject(value)) errors.push(`${path} must be an object`);
  return isPlainObject(value);
}

function string(value, path, errors, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) errors.push(`${path} must be a non-empty string`);
}

function date(value, path, errors) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) errors.push(`${path} must be an ISO date`);
}

function verificationFields(run, probeVersion, errors) {
  if (run.trust === 'verified') {
    if (!object(run.verification, 'run.verification', errors)) return;
    for (const field of ['workflow', 'runId', 'url']) string(run.verification[field], `run.verification.${field}`, errors);
    if (run.verification.probeVersion !== probeVersion) errors.push('run.verification.probeVersion must match probe.version');
  }
  if (run.trust === 'disputed') {
    if (!object(run.dispute, 'run.dispute', errors)) return;
    string(run.dispute.reported, 'run.dispute.reported', errors);
    string(run.dispute.observed, 'run.dispute.observed', errors);
  }
}

export function validateCell(value) {
  const errors = [];
  if (!object(value, 'cell', errors)) return { ok: false, errors };
  if (value.schemaVersion !== 2) errors.push('schemaVersion must be 2');
  if (!HEX64.test(value.cacheKey || '')) errors.push('cacheKey must be a sha256 hex digest');

  if (object(value.plugin, 'plugin', errors)) {
    for (const field of ['name', 'requestedVersion', 'resolvedVersion']) string(value.plugin[field], `plugin.${field}`, errors);
    if (typeof value.plugin.local !== 'boolean') errors.push('plugin.local must be boolean');
    if (value.plugin.local === false && typeof value.plugin.integrity !== 'string') errors.push('registry integrity is required');
    if (value.plugin.local === true && typeof value.plugin.sourceDigest !== 'string') errors.push('local sourceDigest is required');
    // A plugin the host rejected was never loaded, so there is no loaded version
    // to record. Requiring one here made createCell throw and aborted the whole
    // matrix run on the first rejection.
    if (value.run?.outcome === 'completed' && value.result?.status !== 'rejected-by-host') {
      string(value.plugin.loadedVersion, 'plugin.loadedVersion', errors);
    }
    if (value.plugin.loadedVersion !== undefined && value.plugin.loadedVersion !== value.plugin.resolvedVersion) {
      errors.push('plugin.loadedVersion must equal resolvedVersion');
    }
  }

  if (object(value.dsh, 'dsh', errors)) {
    string(value.dsh.version, 'dsh.version', errors);
    string(value.dsh.source, 'dsh.source', errors);
    if (!['headless', 'web'].includes(value.dsh.composition)) errors.push('dsh.composition must be headless or web');
  }
  if (object(value.probe, 'probe', errors)) {
    string(value.probe.version, 'probe.version', errors);
    string(value.probe.isolation, 'probe.isolation', errors);
    if (object(value.probe.host, 'probe.host', errors)) {
      string(value.probe.host.os, 'probe.host.os', errors);
      string(value.probe.host.node, 'probe.host.node', errors);
    }
  }

  if (object(value.run, 'run', errors)) {
    if (!OUTCOME.has(value.run.outcome)) errors.push('run.outcome must be completed or error');
    if (!TRUST.has(value.run.trust)) errors.push('run.trust is invalid');
    date(value.run.at, 'run.at', errors);
    if (!Number.isFinite(value.run.durationMs) || value.run.durationMs < 0) errors.push('run.durationMs must be non-negative');
    verificationFields(value.run, value.probe?.version, errors);
    if (value.run.outcome === 'error') {
      if (value.result !== undefined) errors.push('error cells must not contain a plugin verdict');
      if (object(value.run.error, 'run.error', errors)) {
        string(value.run.error.code, 'run.error.code', errors);
        string(value.run.error.message, 'run.error.message', errors);
      }
    }
  }

  if (value.run?.outcome === 'completed') {
    if (object(value.result, 'result', errors)) {
      string(value.result.status, 'result.status', errors);
      if (!Array.isArray(value.result.entries)) errors.push('result.entries must be an array');
      if (!Array.isArray(value.result.awaitedServices)) errors.push('result.awaitedServices must be an array');
      string(value.result.clientHalf, 'result.clientHalf', errors);
      if (value.result.composition !== value.dsh?.composition) errors.push('result.composition must match dsh.composition');
    }
    if (object(value.evidence, 'evidence', errors)) {
      string(value.evidence.note, 'evidence.note', errors, { allowEmpty: true });
      if (!HEX64.test(value.evidence.outputSha256 || '')) errors.push('evidence.outputSha256 must be a sha256 hex digest');
    }
    if (object(value.reproduce, 'reproduce', errors)) string(value.reproduce.command, 'reproduce.command', errors);
  }

  if (HEX64.test(value.cacheKey || '') && value.plugin?.resolvedVersion && value.dsh?.composition && value.probe?.version) {
    try {
      const expected = cacheKeyFor({
        artifact: value.plugin,
        dshVersion: value.dsh.version,
        composition: value.dsh.composition,
        probeVersion: value.probe.version,
      });
      if (expected !== value.cacheKey) errors.push('cacheKey does not match the artifact inputs');
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateIndex(value) {
  const errors = [];
  if (!object(value, 'index', errors)) return { ok: false, errors };
  if (value.schemaVersion !== 2) errors.push('index.schemaVersion must be 2');
  date(value.generatedAt, 'index.generatedAt', errors);
  if (!Array.isArray(value.dshVersions) || value.dshVersions.some((entry) => typeof entry !== 'string')) errors.push('index.dshVersions must be strings');
  if (!Array.isArray(value.plugins)) {
    errors.push('index.plugins must be an array');
    return { ok: false, errors };
  }
  for (const [pluginIndex, plugin] of value.plugins.entries()) {
    string(plugin.name, `plugins[${pluginIndex}].name`, errors);
    if (!Array.isArray(plugin.versions)) {
      errors.push(`plugins[${pluginIndex}].versions must be an array`);
      continue;
    }
    for (const [versionIndex, version] of plugin.versions.entries()) {
      string(version.version, `plugins[${pluginIndex}].versions[${versionIndex}].version`, errors);
      if (!Array.isArray(version.cells)) {
        errors.push(`plugins[${pluginIndex}].versions[${versionIndex}].cells must be an array`);
        continue;
      }
      for (const [cellIndex, cell] of version.cells.entries()) {
        const path = `plugins[${pluginIndex}].versions[${versionIndex}].cells[${cellIndex}]`;
        if (!HEX64.test(cell.cacheKey || '')) errors.push(`${path}.cacheKey is invalid`);
        string(cell.dsh, `${path}.dsh`, errors);
        if (!['headless', 'web'].includes(cell.composition)) errors.push(`${path}.composition is invalid`);
        string(cell.status, `${path}.status`, errors);
        string(cell.trust, `${path}.trust`, errors);
        date(cell.at, `${path}.at`, errors);
        if (!Array.isArray(cell.toolsAdded)) errors.push(`${path}.toolsAdded must be an array`);
        string(cell.reproduce, `${path}.reproduce`, errors);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateManifest(value) {
  const errors = [];
  if (!object(value, 'manifest', errors)) return { ok: false, errors };
  if (value.schemaVersion !== 2) errors.push('manifest.schemaVersion must be 2');
  string(value.runId, 'manifest.runId', errors);
  date(value.generatedAt, 'manifest.generatedAt', errors);
  string(value.probeVersion, 'manifest.probeVersion', errors);
  if (!HEX64.test(value.inputsSha256 || '')) errors.push('manifest.inputsSha256 is invalid');
  if (!Array.isArray(value.artifacts)) {
    errors.push('manifest.artifacts must be an array');
    return { ok: false, errors };
  }
  const paths = new Set();
  for (const [index, artifact] of value.artifacts.entries()) {
    const path = artifact.path;
    if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path === '..' || path.startsWith('../') || path.includes('/../') || path.includes('\0')) {
      errors.push(`artifacts[${index}].path is not a safe relative path`);
    }
    if (paths.has(path)) errors.push(`artifacts[${index}].path is duplicated`);
    paths.add(path);
    if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) errors.push(`artifacts[${index}].bytes must be non-negative`);
    if (!HEX64.test(artifact.sha256 || '')) errors.push(`artifacts[${index}].sha256 is invalid`);
  }
  return { ok: errors.length === 0, errors };
}
