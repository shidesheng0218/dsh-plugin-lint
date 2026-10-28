import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { sha256 } from '../shared/hash.js';
import { validateManifest } from './schema.js';
import { verifyPublicArtifact } from './export.js';

const MAX_FILES = 10000;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function safeRelative(path) {
  return typeof path === 'string' && !path.startsWith('/') && !path.includes('\\') && path !== '..' && !path.startsWith('../') && !path.includes('/../') && !path.includes('\0');
}

export async function syncMatrix({ source, outDir, fetchImpl = fetch }) {
  if (!source) throw new ToolError('MATRIX_SOURCE_REQUIRED', 'An explicit matrix source is required.');
  if (!outDir) throw new ToolError('MATRIX_OUTPUT_REQUIRED', 'An explicit sync output directory is required.');
  const remote = /^https:\/\//.test(source);
  const base = remote ? new URL(source.endsWith('/') ? source : source + '/') : realpathSync(source);
  async function readSource(path) {
    if (!safeRelative(path)) throw new ToolError('MANIFEST_INVALID', 'The source contains an unsafe artifact path.');
    if (remote) {
      const url = new URL(path, base);
      if (url.protocol !== 'https:') throw new ToolError('MATRIX_SOURCE_UNSUPPORTED', 'Only HTTPS matrix sources are supported.');
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new ToolError('MATRIX_SOURCE_UNAVAILABLE', `The matrix source returned HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new ToolError('ARTIFACT_TOO_LARGE', 'A matrix artifact exceeds the size limit.');
      return bytes;
    }
    const pathOnDisk = realpathSync(resolve(base, path));
    if (pathOnDisk !== base && !pathOnDisk.startsWith(base + sep)) throw new ToolError('MANIFEST_INVALID', 'A source file escapes the source directory.');
    const bytes = readFileSync(pathOnDisk);
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new ToolError('ARTIFACT_TOO_LARGE', 'A matrix artifact exceeds the size limit.');
    return bytes;
  }

  const manifest = JSON.parse((await readSource('manifest.json')).toString('utf8'));
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new ToolError('MANIFEST_INVALID', validation.errors.join('; '));
  if (manifest.artifacts.length > MAX_FILES) throw new ToolError('ARTIFACT_TOO_LARGE', 'The matrix declares too many files.');
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.sync-'));
  try {
    for (const artifact of manifest.artifacts) {
      const bytes = await readSource(artifact.path);
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
        throw new ToolError('ARTIFACT_INTEGRITY_MISMATCH', `Artifact integrity mismatch: ${artifact.path}`);
      }
      const destination = join(staging, artifact.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const verification = await verifyPublicArtifact({ dir: staging });
    if (!verification.ok) throw new ToolError('ARTIFACT_INTEGRITY_MISMATCH', verification.errors.join('; '));
    const backup = `${outDir}.backup-${Date.now()}`;
    if (existsSync(outDir)) renameSync(outDir, backup);
    try {
      renameSync(staging, outDir);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, outDir);
      throw error;
    }
    return { manifest, filesWritten: manifest.artifacts.length + 1 };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
