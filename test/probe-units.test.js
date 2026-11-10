import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitedServices,
  noteOf,
  payloadOf,
  probePackage,
  redact,
  rejectionOf,
} from '../src/probe/probe.js';
import { probeFixture } from './probe-helpers.js';

test('awaitedServices reads both the singular and the plural host wording', () => {
  assert.deepEqual(awaitedServices([
    { reason: 'waiting for service: webServer' },
    { reason: 'waiting for services: webServer, webRuntime' },
    { reason: 'waiting for services: webServer' },
    { reason: 'Error: boom' },
  ]), ['webServer', 'webRuntime']);
  assert.deepEqual(awaitedServices([{ reason: undefined }]), []);
});

test('redact removes token query values but keeps the diagnostic shape', () => {
  assert.equal(redact('GET https://x.test/?token=secret&a=1'), 'GET https://x.test/?token=<redacted>&a=1');
});

test('noteOf keeps a short diagnostic and drops credential sentinels and stack frames', () => {
  const note = noteOf('MISSING_CREDENTIAL\n  at thing\nprovider failed\nsecond line\nthird\nfourth');
  assert.match(note, /provider failed/);
  assert.doesNotMatch(note, /MISSING_CREDENTIAL/);
  assert.doesNotMatch(note, /at thing/);
});

test('payloadOf keeps the last request that carries a tool list', () => {
  assert.deepEqual(payloadOf([{ tools: [{ name: 'a' }] }, { other: true }, { tools: [{ name: 'b' }] }]), { tools: [{ name: 'b' }] });
  assert.equal(payloadOf([{ other: true }]), undefined);
});

test('rejectionOf extracts the host rejection reason', () => {
  assert.equal(rejectionOf('noise\ninstallation rejected: peer conflict\ntail'), 'peer conflict');
  assert.equal(rejectionOf('no rejection here'), undefined);
});

test('a host rejection is rejected-by-host and does not require an installed manifest', async (t) => {
  const fixture = probeFixture(t);
  fixture.environment.install = async () => ({ out: 'installation rejected: peer conflict' });
  const observation = await probePackage({ ...fixture, composition: 'headless' });
  assert.equal(observation.outcome, 'completed');
  assert.equal(observation.result.status, 'rejected-by-host');
  assert.equal(observation.result.rejection, 'peer conflict');
  assert.equal(fixture.environment.calls.destroy, 1);
});

test('a boot that never writes a profile is TEMPLATE_FAILED', async (t) => {
  const fixture = probeFixture(t);
  fixture.environment.boot = async () => ({ out: '' });
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'error');
  assert.equal(observation.error.code, 'TEMPLATE_FAILED');
});

test('a cleanup failure is recorded without changing the verdict', async (t) => {
  const fixture = probeFixture(t);
  fixture.environment.destroy = async () => { throw new Error('cleanup failed'); };
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'completed');
  assert.equal(observation.result.status, 'active');
  assert.equal(observation.cleanup.code, 'ISOLATION_CLEANUP_FAILED');

  const broken = probeFixture(t, { install: 'missing' });
  broken.environment.destroy = async () => { throw new Error('cleanup failed'); };
  const failed = await probePackage({ ...broken });
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.error.code, 'ARTIFACT_MISSING', 'the original error is preserved');
  assert.equal(failed.cleanup.code, 'ISOLATION_CLEANUP_FAILED');
});

test('tools mode diffs the baseline and post-install tool lists', async (t) => {
  const fixture = probeFixture(t);
  const baseline = {
    tools: [{ name: 'keep' }, { name: 'drop' }],
    system: 'baseline',
    dsh_plugin_packages: { packages: [] },
  };
  const after = {
    tools: [{ name: 'keep' }, { name: 'added' }],
    system: 'after installation',
    dsh_plugin_packages: { packages: [{ name: 'demo', version: '1.2.3' }] },
  };
  let syncs = 0;
  const stub = {
    seen: [baseline],
    baseURL: 'http://127.0.0.1:1',
    server: { close() {} },
    async sync() {
      syncs += 1;
      // The first sync follows the baseline boot; the second follows the
      // post-install boot and supplies the new payload.
      if (syncs > 1) stub.seen.push(after);
    },
  };
  const observation = await probePackage({ ...fixture, tools: true, stub });
  assert.equal(observation.outcome, 'completed');
  assert.deepEqual(observation.tools.added, ['added']);
  assert.deepEqual(observation.tools.removed, ['drop']);
  assert.equal(observation.tools.baseline, 2);
  assert.equal(observation.tools.total, 2);
  assert.equal(observation.systemPrompt.baselineChars > 0, true);
  assert.deepEqual(observation.packagesAdded, ['demo@1.2.3']);
});
test('a numeric infrastructure code becomes a schema-safe PROBE_FAILED', async (t) => {
  const fixture = probeFixture(t);
  fixture.environment.materialize = async () => { throw Object.assign(new Error('bad artifact'), { code: 1 }); };
  const observation = await probePackage({ ...fixture });
  assert.equal(observation.outcome, 'error');
  assert.equal(observation.error.code, 'PROBE_FAILED');
});
