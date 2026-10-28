const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
let updateCache;

export function isNewer(latest, current) {
  const a = String(latest ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(current ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export async function latestPublishedVersion({ fetchImpl = fetch, now = Date.now() } = {}) {
  const time = typeof now === 'function' ? now() : now;
  if (updateCache && time - updateCache.at < UPDATE_TTL_MS) return updateCache.version;
  try {
    const response = await fetchImpl('https://registry.npmjs.org/@shidesheng0218/dsh-plugin-lint-panel/latest', {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return undefined;
    const meta = await response.json();
    const version = typeof meta?.version === 'string' ? meta.version : undefined;
    if (version) updateCache = { at: time, version };
    return version;
  } catch {
    return undefined;
  }
}
