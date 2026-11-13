import { satisfies } from './semver.js';

/** DSH peer declarations the host checks before importing a plugin. */
export function dshPeers(manifest) {
  return Object.entries((manifest && manifest.peerDependencies) || {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .map(([name, range]) => ({ name, range: String(range) }));
}

/**
 * Evaluate the host's admission rule for one target runtime.
 *
 * The host requires every DSH peer range to accept the single runtime version
 * and lets prereleases participate. Missing peers impose no constraint; a range
 * this module cannot decide is reported as 'unknown', never as a rejection.
 */
export function evaluatePeers(manifest, runtime) {
  const peers = dshPeers(manifest);
  const result = {
    runtime: runtime || null,
    peers,
    verdict: 'no-constraint',
    unsatisfied: [],
    undecidable: [],
  };
  if (!runtime || peers.length === 0) return result;
  for (const peer of peers) {
    // The host substitutes the runtime version for workspace:^/~/* before
    // comparing, so those ranges always match.
    if (['workspace:^', 'workspace:~', 'workspace:*'].includes(peer.range)) continue;
    const verdict = satisfies(runtime, peer.range);
    if (verdict === null) result.undecidable.push(peer);
    else if (verdict === false) result.unsatisfied.push(peer);
  }
  result.verdict = result.unsatisfied.length > 0 ? 'will-reject'
    : result.undecidable.length > 0 ? 'unknown'
      : 'will-load';
  return result;
}