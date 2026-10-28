import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const matrixRefresh = readFileSync(new URL('../.github/workflows/matrix-refresh.yml', import.meta.url), 'utf8');
const verifySample = readFileSync(new URL('../.github/workflows/verify-sample.yml', import.meta.url), 'utf8');
const action = readFileSync(new URL('../.github/actions/probe/action.yml', import.meta.url), 'utf8');

function section(text, job) {
  const start = text.indexOf(`  ${job}:\n`);
  assert.ok(start >= 0, `missing job ${job}`);
  const rest = text.slice(start + `  ${job}:\n`.length);
  const match = /^  [a-zA-Z][\w-]*:\n/m.exec(rest);
  return match ? rest.slice(0, match.index) : rest;
}

function assertReadOnlyProbeWorkflow(text, artifactName) {
  const probe = section(text, 'probe');
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(probe, /persist-credentials: false/);
  assert.doesNotMatch(probe, /gh pr create|git push|git commit|contents: write|pull-requests: write|secrets\./);
  assert.match(probe, /actions\/upload-artifact@v4/);
  assert.match(probe, new RegExp(`name: ${artifactName}`));
}

function assertOfflinePublishWorkflow(text) {
  const publish = section(text, 'publish');
  assert.match(publish, /contents: write/);
  assert.match(publish, /pull-requests: write/);
  assert.match(publish, /verify-public\.mjs/);
  assert.match(publish, /gh pr create/);
  assert.doesNotMatch(publish, /gh pr merge/);
  assert.doesNotMatch(publish, /scripts\/matrix\/run\.mjs|probe-boot|resolveDsh|npm install|pnpm|node_modules\/.bin/);
  assert.match(publish, /github\.event_name != 'pull_request'/);
}

test('matrix refresh separates isolated probe from offline data publication', () => {
  assertReadOnlyProbeWorkflow(matrixRefresh, 'matrix-candidate');
  assert.match(section(matrixRefresh, 'probe'), /--target-mode refresh-latest/);
  assertOfflinePublishWorkflow(matrixRefresh);
});

test('sample verification separates isolated probe from trusted offline publication', () => {
  assertReadOnlyProbeWorkflow(verifySample, 'verification-candidate');
  assertOfflinePublishWorkflow(verifySample);
  assert.match(section(verifySample, 'publish'), /--verification/);
  assert.match(section(verifySample, 'publish'), /checked.*0|"0"/);
});

test('author probe action resolves the real script and creates output before tee', () => {
  assert.match(action, /github\.action_path \}\}\/\.\.\/\.\.\/\.\.\/scripts\/matrix\/run\.mjs/);
  assert.equal(existsSync(fileURLToPath(new URL('../scripts/matrix/run.mjs', import.meta.url))), true);
  assert.ok(action.indexOf('mkdir -p') < action.indexOf('| tee'), 'mkdir must precede tee');
  assert.match(action, /--target-mode refresh-latest/);
});
