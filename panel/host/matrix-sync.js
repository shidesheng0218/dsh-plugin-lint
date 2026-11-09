import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * A self-contained copy of the artifact sync used by the CLI.
 *
 * Why this file exists: `panel/` is published as its own npm package, and its
 * `files[]` cannot reach `../../src/`. Importing the linter's sync made the
 * packaged host half fail at module resolution, so the panel is now standalone.
 *
 * The two implementations differ by design in one place: the CLI re-derives the
 * index from the cells (`verifyPublicArtifact`) because it publishes evidence;
 * the panel only displays it, so it verifies every byte against the manifest
 * and checks that the two files it reads are present and schema-valid. That
 * difference is pinned by a test that runs both over the same fixture and
 * compares the written bytes.
 */

const MAX_FILES = 10000;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED = ['index/latest.json', 'aggregate.json'];

export class MatrixSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MatrixSyncError';
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelative(path) {
  return typeof path === 'string'
    && !path.startsWith('/')
    && !path.includes('\\')
    && path !== '..'
    && !path.startsWith('../')
    && !path.includes('/../')
    && !path.includes('\0');
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be an object'];
  }
  if (manifest.schemaVersion !== 2) errors.push('manifest.schemaVersion must be 2');
  if (!Array.isArray(manifest.artifacts)) {
    errors.push('manifest.artifacts must be an array');
    return errors;
  }
  const paths = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object') {
      errors.push(`artifacts[${index}] must be an object`);
      continue;
    }
    if (!safeRelative(artifact.path)) errors.push(`artifacts[${index}].path is not a safe relative path`);
    if (paths.has(artifact.path)) errors.push(`artifacts[${index}].path is duplicated`);
    paths.add(artifact.path);
    if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) errors.push(`artifacts[${index}].bytes must be non-negative`);
    if (!HEX64.test(artifact.sha256 || '')) errors.push(`artifacts[${index}].sha256 is invalid`);
  }
  return errors;
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

export async function syncMatrix({ source, outDir, fetchImpl = fetch }) {
  if (!source) throw new MatrixSyncError('MATRIX_SOURCE_REQUIRED', 'An explicit matrix source is required.');
  if (!outDir) throw new MatrixSyncError('MATRIX_OUTPUT_REQUIRED', 'An explicit sync output directory is required.');
  const remote = /^https:\/\//.test(source);
  const base = remote ? new URL(source.endsWith('/') ? source : source + '/') : realpathSync(source);

  async function readSource(path) {
    if (!safeRelative(path)) throw new MatrixSyncError('MANIFEST_INVALID', 'The source contains an unsafe artifact path.');
    if (remote) {
      const url = new URL(path, base);
      if (url.protocol !== 'https:') throw new MatrixSyncError('MATRIX_SOURCE_UNSUPPORTED', 'Only HTTPS matrix sources are supported.');
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new MatrixSyncError('MATRIX_SOURCE_UNAVAILABLE', `The matrix source returned HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new MatrixSyncError('ARTIFACT_TOO_LARGE', 'A matrix artifact exceeds the size limit.');
      return bytes;
    }
    const pathOnDisk = realpathSync(resolve(base, path));
    if (pathOnDisk !== base && !pathOnDisk.startsWith(base + sep)) {
      throw new MatrixSyncError('MANIFEST_INVALID', 'A source file escapes the source directory.');
    }
    const bytes = readFileSync(pathOnDisk);
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new MatrixSyncError('ARTIFACT_TOO_LARGE', 'A matrix artifact exceeds the size limit.');
    return bytes;
  }

  const manifest = JSON.parse((await readSource('manifest.json')).toString('utf8'));
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length > 0) throw new MatrixSyncError('MANIFEST_INVALID', manifestErrors.join('; '));
  if (manifest.artifacts.length > MAX_FILES) throw new MatrixSyncError('ARTIFACT_TOO_LARGE', 'The matrix declares too many files.');

  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.sync-'));
  try {
    for (const artifact of manifest.artifacts) {
      const bytes = await readSource(artifact.path);
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
        throw new MatrixSyncError('ARTIFACT_INTEGRITY_MISMATCH', `Artifact integrity mismatch: ${artifact.path}`);
      }
      const destination = join(staging, artifact.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // The panel reads exactly these two files. Verify they are present, parse,
    // and carry the schema the reader expects before the cache is swapped in.
    for (const required of REQUIRED) {
      if (!manifest.artifacts.some((artifact) => artifact.path === required)) {
        throw new MatrixSyncError('ARTIFACT_INCOMPLETE', `The matrix artifact does not declare ${required}.`);
      }
      const parsed = parseJson(readFileSync(join(staging, required)));
      if (!parsed || parsed.schemaVersion !== 2) {
        throw new MatrixSyncError('ARTIFACT_INCOMPLETE', `${required} is not a readable schema v2 document.`);
      }
    }

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