import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncMatrix } from '../../src/matrix/sync.js';
import { profileDir } from './profile.js';

/**
 * Where the public matrix lives. The public artifact is committed to the
 * repository under matrix/public, so the canonical remote source is the raw
 * file tree on the default branch. syncMatrix fetches manifest.json first and
 * then each declared artifact, verifying every byte against the manifest.
 */
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/shidesheng0218/dsh-plugin-lint/main/matrix/public/';

/** How old a local snapshot may be before a background refresh is attempted. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * The cache lives under the active DSH profile, not inside the installed
 * package — an npm-installed plugin directory may be read-only, and the cache
 * is per-profile state, not package payload.
 */
function defaultCacheDir() {
  const profile = profileDir();
  return profile ? join(profile, '.dsh-plugin-lint', 'matrix') : undefined;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function currentTime(now) {
  return typeof now === 'function' ? now() : now;
}

function snapshotAgeMs(cacheDir, now) {
  const generatedAt = readJson(join(cacheDir, 'manifest.json'))?.generatedAt;
  const parsed = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(parsed)) return Infinity;
  return currentTime(now) - parsed;
}

/**
 * Best-effort refresh of the public matrix into a local cache directory.
 *
 * This never throws and never blocks the caller with a failure: a network or
 * integrity problem resolves to { ok: false, reason } and the caller keeps
 * using whatever local data it already had. Data is evidence, and a stale
 * snapshot is still evidence — the panel must not go dark because a refresh
 * failed.
 */
export async function refreshPublicMatrix({
  cacheDir = defaultCacheDir(),
  source = DEFAULT_SOURCE,
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  if (!cacheDir) return { ok: false, reason: 'no-cache-dir' };
  mkdirSync(cacheDir, { recursive: true });
  try {
    const result = await syncMatrix({ source, outDir: cacheDir, fetchImpl });
    return { ok: true, generatedAt: result.manifest?.generatedAt, files: result.filesWritten };
  } catch (error) {
    return { ok: false, reason: error?.code || 'sync-failed', message: error?.message };
  }
}

/**
 * Kick off a background refresh only when the cached snapshot is missing or
 * older than maxAgeMs. Returns immediately; the refresh resolves on its own.
 * The `onDone` callback is optional and is used by tests to observe the
 * outcome without polling.
 */
export function maybeRefreshInBackground({
  cacheDir = defaultCacheDir(),
  source = DEFAULT_SOURCE,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  fetchImpl = fetch,
  onDone,
} = {}) {
  if (!cacheDir) return { started: false, reason: 'no-cache-dir' };
  const age = snapshotAgeMs(cacheDir, now);
  if (age < maxAgeMs) return { started: false, reason: 'fresh' };
  const promise = refreshPublicMatrix({ cacheDir, source, now, fetchImpl });
  if (typeof onDone === 'function') promise.then(onDone, () => {});
  return { started: true, promise };
}

export { DEFAULT_SOURCE, DEFAULT_MAX_AGE_MS, defaultCacheDir };
