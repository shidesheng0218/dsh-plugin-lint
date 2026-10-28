import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { ToolError } from '../shared/errors.js';

const REGISTRY = 'https://registry.npmjs.org/';
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function parseSpec(value) {
  const text = String(value);
  const split = text.startsWith('@') ? text.lastIndexOf('@') > text.indexOf('/') : text.lastIndexOf('@') > 0;
  if (!split) return { name: text, version: 'latest' };
  const index = text.lastIndexOf('@');
  return { name: text.slice(0, index), version: text.slice(index + 1) || 'latest' };
}

function validateName(name) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
    throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', 'The artifact package name is invalid.');
  }
}

function validateRequestedVersion(version) {
  if (EXACT_VERSION.test(version)) return version;
  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(version)) return version;
  throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', `Artifact version ranges are not reproducible inputs: ${version}`);
}

function localArtifact(target) {
  const root = resolve(target.path || target);
  const manifestPath = join(root, 'package.json');
  let manifest;
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new ToolError('ARTIFACT_SPEC_UNSUPPORTED', 'Local artifacts must be package directories with a readable package.json.', { cause });
  }
  const name = manifest.name || target.name;
  validateName(name);
  if (!EXACT_VERSION.test(manifest.version || '')) {
    throw new ToolError('ARTIFACT_METADATA_MISMATCH', 'The local package manifest has no exact version.');
  }
  const hash = createHash('sha256');
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const relative = absolute.slice(root.length + 1).replace(/\\/g, '/');
        hash.update(relative);
        hash.update('\0');
        hash.update(readFileSync(absolute));
        hash.update('\0');
      }
    }
  }
  walk(root);
  return {
    name,
    requestedVersion: 'local',
    resolvedVersion: manifest.version,
    integrity: undefined,
    tarballUrl: undefined,
    installTarget: root,
    local: true,
    path: root,
    sourceDigest: hash.digest('hex'),
  };
}

export async function resolveArtifact(target, { fetchImpl = fetch } = {}) {
  if ((typeof target === 'string' && existsSync(target)) || (target && typeof target === 'object' && (target.local || target.path))) {
    return localArtifact(target);
  }
  const input = typeof target === 'string' ? parseSpec(target) : { name: target?.name, version: target?.version ?? 'latest', integrity: target?.integrity };
  validateName(input.name);
  const requestedVersion = validateRequestedVersion(input.version || 'latest');
  const url = REGISTRY + encodeURIComponent(input.name);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  } catch (cause) {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', 'The npm registry could not be read.', { cause });
  }
  if (!response?.ok) throw new ToolError('ARTIFACT_REGISTRY_ERROR', `The npm registry returned HTTP ${response?.status ?? 'unknown'}.`);
  let metadata;
  try {
    metadata = await response.json();
  } catch (cause) {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', 'The npm registry returned invalid JSON.', { cause });
  }
  const resolvedVersion = EXACT_VERSION.test(requestedVersion)
    ? requestedVersion
    : metadata?.['dist-tags']?.[requestedVersion];
  if (!EXACT_VERSION.test(resolvedVersion || '')) {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', `The registry did not provide an exact version for ${input.name}@${requestedVersion}.`);
  }
  const versionMetadata = metadata?.versions?.[resolvedVersion];
  if (!versionMetadata || (versionMetadata.version !== undefined && versionMetadata.version !== resolvedVersion)) {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', 'The registry metadata does not contain the resolved version.');
  }
  const integrity = versionMetadata?.dist?.integrity;
  const tarballUrl = versionMetadata?.dist?.tarball;
  if (typeof integrity !== 'string' || typeof tarballUrl !== 'string') {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', 'The registry artifact is missing tarball or integrity metadata.');
  }
  let parsedTarball;
  try {
    parsedTarball = new URL(tarballUrl);
  } catch (cause) {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', 'The registry returned an invalid tarball URL.', { cause });
  }
  if (parsedTarball.protocol !== 'https:' || parsedTarball.hostname !== 'registry.npmjs.org') {
    throw new ToolError('ARTIFACT_REGISTRY_ERROR', 'The registry returned a tarball outside the explicit registry origin.');
  }
  if (input.integrity !== undefined && input.integrity !== integrity) {
    throw new ToolError('ARTIFACT_INTEGRITY_MISMATCH', 'The target integrity differs from the registry metadata.');
  }
  return {
    name: input.name,
    requestedVersion,
    resolvedVersion,
    integrity,
    tarballUrl,
    installTarget: `${input.name}@${resolvedVersion}`,
    local: false,
    sourceDigest: integrity,
  };
}

export function verifyIntegrity(bytes, integrity) {
  if (typeof integrity !== 'string') return false;
  const match = /^([A-Za-z0-9]+)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match || !['sha256', 'sha384', 'sha512'].includes(match[1])) return false;
  try {
    const actual = createHash(match[1]).update(bytes).digest();
    const expected = Buffer.from(match[2], 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function downloadArtifact(artifact, { fetchImpl = fetch, destination } = {}) {
  if (artifact.local) return { ...artifact, tarballPath: artifact.path };
  const response = await fetchImpl(artifact.tarballUrl);
  if (!response?.ok) throw new ToolError('ARTIFACT_DOWNLOAD_FAILED', `The artifact download returned HTTP ${response?.status ?? 'unknown'}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verifyIntegrity(bytes, artifact.integrity)) {
    throw new ToolError('ARTIFACT_INTEGRITY_MISMATCH', 'The downloaded artifact does not match its pinned integrity.');
  }
  const target = destination || join(mkdtempSync(join(tmpdir(), 'dsh-artifact-')), basename(artifact.tarballUrl));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, bytes);
  return { ...artifact, tarballPath: target };
}
