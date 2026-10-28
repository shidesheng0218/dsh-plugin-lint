import { stableStringify, sha256 } from '../shared/hash.js';
import { ToolError } from '../shared/errors.js';
import { CELL_SCHEMA_VERSION } from '../shared/version.js';

export function cacheKeyFor({ artifact, dshVersion, composition, probeVersion, schemaVersion = CELL_SCHEMA_VERSION }) {
  const integrityOrSourceDigest = artifact?.integrity ?? artifact?.sourceDigest;
  if (!artifact?.name || !artifact?.resolvedVersion || !integrityOrSourceDigest || !dshVersion || !composition || !probeVersion) {
    throw new ToolError('CACHE_INPUT_INVALID', 'A reproducible cache key needs artifact, DSH, composition, probe, and integrity inputs.');
  }
  return sha256(stableStringify({
    name: artifact.name,
    resolvedVersion: artifact.resolvedVersion,
    integrityOrSourceDigest,
    dshVersion,
    composition,
    probeVersion,
    cellSchemaVersion: schemaVersion,
  }));
}
