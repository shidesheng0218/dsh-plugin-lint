import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const matrixRefresh = readFileSync(new URL('../.github/workflows/matrix-refresh.yml', import.meta.url), 'utf8');
const verifySample = readFileSync(new URL('../.github/workflows/verify-sample.yml', import.meta.url), 'utf8');

function assertReadOnlyProbeWorkflow(text, artifactName) {
  assert.match(text, /permissions:\n  contents: read/);
  assert.doesNotMatch(text, /contents: write|pull-requests: write/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /^  probe:/m);
  assert.doesNotMatch(text, /gh pr create|git push|git commit/);
  assert.match(text, new RegExp('actions/upload-artifact@v4'));
  assert.match(text, new RegExp(`name: ${artifactName}`));
}

test('matrix refresh exposes only a read-only probe artifact job', () => {
  assertReadOnlyProbeWorkflow(matrixRefresh, 'matrix-candidate');
});

test('sample verification exposes only a read-only probe artifact job', () => {
  assertReadOnlyProbeWorkflow(verifySample, 'verification-candidate');
});
