import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion, satisfies, isDecidableRange } from '../src/core/semver.js';

const v = (text) => parseVersion(text);

test('parseVersion and compareVersions follow semver ordering', () => {
  assert.equal(compareVersions(v('1.2.3'), v('1.2.3')), 0);
  assert.equal(compareVersions(v('1.2.4'), v('1.2.3')), 1);
  assert.equal(compareVersions(v('1.10.0'), v('1.9.9')), 1);
  assert.equal(compareVersions(v('1.0.0-alpha'), v('1.0.0')), -1);
  assert.equal(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1')), -1);
  assert.equal(compareVersions(v('1.0.0-alpha.1'), v('1.0.0-alpha.beta')), -1);
  assert.equal(compareVersions(v('1.0.0-beta.2'), v('1.0.0-beta.11')), -1);
  assert.equal(parseVersion('not-a-version'), null);
});

test('exact, partial and wildcard ranges', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.2.9', '1.2'), true);
  assert.equal(satisfies('1.3.0', '1.2'), false);
  assert.equal(satisfies('1.9.9', '1'), true);
  assert.equal(satisfies('2.0.0', '1'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('1.2.3', 'x'), true);
});

test('comparators and prerelease participation match the host behaviour', () => {
  assert.equal(satisfies('0.2.2-alpha.3', '>=0.2.0'), true, 'includePrerelease accepts a newer prerelease');
  assert.equal(satisfies('0.1.9', '>=0.2.0'), false);
  assert.equal(satisfies('0.2.2-rc.1', '>=0.2.1-rc.3'), true);
  assert.equal(satisfies('0.2.1-rc.2', '>=0.2.1-rc.3'), false);
  assert.equal(satisfies('0.2.0', '<0.2.1'), true);
  assert.equal(satisfies('0.2.1', '<0.2.1'), false);
  assert.equal(satisfies('0.2.1', '<=0.2.1'), true);
  assert.equal(satisfies('0.2.9', '<=0.2'), true);
  assert.equal(satisfies('0.3.0', '<=0.2'), false);
  assert.equal(satisfies('0.3.0', '>0.2'), true);
  assert.equal(satisfies('0.2.9', '>0.2'), false);
});

test('caret and tilde ranges use the npm upper bounds', () => {
  assert.equal(satisfies('1.9.9', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.9.9', '~1'), true);
  assert.equal(satisfies('2.0.0', '~1'), false);
});

test('hyphen ranges and OR alternatives', () => {
  assert.equal(satisfies('1.5.0', '1.2.3 - 2.3.4'), true);
  assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true);
  assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false);
  assert.equal(satisfies('2.9.0', '1.2 - 2.3'), false);
  assert.equal(satisfies('2.3.9', '1.2 - 2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
});

test('ranges outside the grammar are undecidable, never guessed', () => {
  assert.equal(isDecidableRange('workspace:^'), false);
  assert.equal(isDecidableRange('latest'), false);
  assert.equal(isDecidableRange('git+https://example.test/repo'), false);
  assert.equal(satisfies('0.2.0', 'workspace:^'), null);
  assert.equal(satisfies('0.2.0', '>=0.2.0 <0.3.0'), true);
});