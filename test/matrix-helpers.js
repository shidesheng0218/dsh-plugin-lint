import { sha256 } from '../src/shared/hash.js';

export const PROVENANCE = {
  workflow: 'verify-sample',
  runId: 'run-123',
  url: 'https://github.com/example/actions/runs/123',
  probeVersion: '0.4.0',
};

export function artifact123() {
  return {
    name: 'demo',
    requestedVersion: 'latest',
    resolvedVersion: '1.2.3',
    integrity: 'sha512-abc',
    installTarget: 'demo@1.2.3',
    local: false,
    sourceDigest: 'sha512-abc',
  };
}

export function completedObservation() {
  return {
    outcome: 'completed',
    loadedVersion: '1.2.3',
    install: 'ok',
    durationMs: 12,
    result: {
      status: 'active',
      composition: 'headless',
      awaitedServices: [],
      entries: [],
      tools: { added: ['demo_tool'] },
      audit: { observed: [] },
      systemPrompt: { chars: 123 },
      clientHalf: 'not-covered',
    },
    note: 'completed',
    outputSha256: sha256('probe output'),
    reproduce: { command: 'node scripts/probe-boot.mjs demo@1.2.3 --dsh 0.2.0-rc.2' },
  };
}

export function cellInput(overrides = {}) {
  const artifact = overrides.artifact || artifact123();
  const composition = overrides.composition || 'headless';
  const observation = overrides.observation || completedObservation();
  if (observation.result) observation.result.composition = composition;
  return {
    artifact,
    dsh: { version: '0.2.0-rc.2', source: 'npm', composition },
    observation,
    isolation: 'docker',
    host: { os: 'linux-x64', node: 'v22.0.0' },
    at: '2026-10-01T00:00:00.000Z',
    probeVersion: '0.4.0',
    ...overrides,
  };
}

export function v1ActiveVerified() {
  return {
    schemaVersion: 1,
    plugin: { name: 'legacy-demo', version: '1.0.0', integrity: 'sha512-legacy', local: false },
    dsh: { version: '0.2.0-rc.2', source: 'npm', profile: 'headless' },
    probe: { tool: 'dsh-plugin-lint/probe', mode: 'headless' },
    run: { at: '2026-09-01T00:00:00.000Z', durationMs: 10, trust: 'verified', os: 'linux-x64', node: 'v22.0.0' },
    result: { status: 'active', composition: 'headless', entries: [], clientHalf: 'not-covered' },
    evidence: { note: 'legacy' },
    reproduce: { command: 'node scripts/probe-boot.mjs legacy-demo --dsh 0.2.0-rc.2' },
  };
}
