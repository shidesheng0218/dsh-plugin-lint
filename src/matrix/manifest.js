import { stableStringify, sha256 } from '../shared/hash.js';
import { ToolError } from '../shared/errors.js';
import { validateManifest } from './schema.js';

export function buildManifest({ runId, generatedAt = new Date().toISOString(), probeVersion, inputs, artifacts }) {
  const manifest = {
    schemaVersion: 2,
    runId,
    generatedAt,
    probeVersion,
    inputsSha256: sha256(stableStringify(inputs)),
    artifacts: [...artifacts].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new ToolError('MANIFEST_INVALID', validation.errors.join('; '));
  return manifest;
}
