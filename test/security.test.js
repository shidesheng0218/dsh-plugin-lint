/**
 * Tests for the experimental security analysis.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSecurityDeep, SECURITY_RULES, SECURITY_LIMITS } from '../src/security.js';
import { maskSource } from '../src/mask.js';

/** A file object shaped the way loadPackage produces one. */
const file = (path, text) => ({ path, text, ...maskSource(text) });

const pkg = (files, entries = {}) => ({ manifest: { name: 'test' }, entries, jsFiles: files });

const rulesHit = (result) => new Set(result.findings.map((f) => f.rule));

test('analyzeSecurityDeep - detects localStorage credential storage', () => {
  const result = analyzeSecurityDeep(pkg([file('auth.js', 'localStorage.setItem("auth_token", token);')]));
  assert.ok(rulesHit(result).has('S2'), 'should detect localStorage credential storage');
  assert.equal(result.findings.find((f) => f.rule === 'S2').level, 'warn', 'heuristic rules cap at warning level');
});

test('analyzeSecurityDeep - detects eval usage', () => {
  const result = analyzeSecurityDeep(pkg([file('dangerous.js', 'eval(userInput); new Function(code)();')]));
  assert.ok(rulesHit(result).has('S3'), 'should detect eval usage');
});

test('analyzeSecurityDeep - detects a dynamic innerHTML assignment', () => {
  const result = analyzeSecurityDeep(pkg([file('client.js', 'element.innerHTML = userData;')], { client: 'client.js' }));
  assert.ok(rulesHit(result).has('S4'), 'should detect unsafe innerHTML');
});

test('analyzeSecurityDeep - detects template-literal innerHTML with interpolation', () => {
  const result = analyzeSecurityDeep(pkg([file('client.js', 'el.innerHTML = `<b>${userInput}</b>`;')], { client: 'client.js' }));
  assert.ok(rulesHit(result).has('S4'), 'interpolated templates are dynamic');
});

test('analyzeSecurityDeep - does not flag a static innerHTML string or a sanitized value', () => {
  const staticResult = analyzeSecurityDeep(pkg([file('client.js', 'el.innerHTML = "<b>static</b>";')], { client: 'client.js' }));
  assert.ok(!rulesHit(staticResult).has('S4'), 'a static string is not a finding');
  const sanitizedResult = analyzeSecurityDeep(pkg([file('client.js', 'el.innerHTML = DOMPurify.sanitize(userData);')], { client: 'client.js' }));
  assert.ok(!rulesHit(sanitizedResult).has('S4'), 'a sanitized value is not a finding');
});

test('analyzeSecurityDeep - detects command injection risks', () => {
  const result = analyzeSecurityDeep(pkg([file('shell.js', 'exec(`rm -rf ${userPath}`);')]));
  assert.ok(rulesHit(result).has('S6'), 'should detect command injection risk');
});

test('analyzeSecurityDeep - detects insecure HTTP request targets', () => {
  const result = analyzeSecurityDeep(pkg([file('network.js', 'fetch("http://api.example.com/sensitive");')]));
  assert.ok(rulesHit(result).has('S10'), 'should detect insecure HTTP');
});

test('analyzeSecurityDeep - ignores comments and string literals', () => {
  const result = analyzeSecurityDeep(pkg([file('docs.js', [
    '// Never do this: eval(userInput); fetch("http://example.com");',
    'const example = "eval(userInput)";',
    'const namespace = "http://www.w3.org/2000/svg";',
    '// localStorage.setItem("token", value) is also discouraged',
  ].join('\n'))]));
  assert.ok(!rulesHit(result).has('S3'), 'a documented eval() is not a call site');
  assert.ok(!rulesHit(result).has('S10'), 'an XML namespace is not a request target');
  assert.ok(!rulesHit(result).has('S2'), 'a commented storage call is not a call site');
});

test('analyzeSecurityDeep - reports observed network domains with a location', () => {
  const result = analyzeSecurityDeep(pkg([file('network.js', 'fetch("https://api.example.com/data");')]));
  const finding = result.findings.find((f) => f.rule === 'S5');
  assert.ok(finding, 'should inventory the external domain');
  assert.equal(finding.level, 'info', 'inventory entries are information, not violations');
  assert.equal(finding.file, 'network.js', 'the finding points at the file it came from');
  assert.ok(finding.line >= 1);
});

test('analyzeSecurityDeep - calculates risk level', () => {
  const result = analyzeSecurityDeep(pkg([file('secure.js', 'console.log("safe code");')]));
  assert.ok(['minimal', 'low', 'medium', 'high'].includes(result.riskLevel), 'should be a valid risk level');
  assert.equal(typeof result.summary.total, 'number', 'should have numeric summary');
});

test('analyzeSecurityDeep - marks the analysis as experimental schema v2', () => {
  const result = analyzeSecurityDeep(pkg([file('secure.js', 'console.log(1);')]));
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.experimental, true);
  assert.deepEqual(result.limits, SECURITY_LIMITS);
  assert.equal(SECURITY_RULES.length, 10);
});

test('the experimental package entry exposes only the versioned analysis API', async () => {
  const api = await import('@shidesheng0218/dsh-plugin-lint/experimental');
  assert.equal(api.EXPERIMENTAL_SCHEMA_VERSION, 2);
  assert.deepEqual(Object.keys(api).sort(), [
    'EXPERIMENTAL_SCHEMA_VERSION',
    'SECURITY_LIMITS',
    'SECURITY_RULES',
    'analyzePerformance',
    'analyzeSecurityDeep',
    'detectConflicts',
  ]);
});

test('analyzeSecurityDeep - categorizes findings', () => {
  const result = analyzeSecurityDeep(pkg([file('mixed.js', 'localStorage.setItem("token", val); eval(code); fetch("http://example.com");')]));
  assert.ok(result.byCategory, 'should have categorized findings');
  assert.ok(Object.keys(result.byCategory).length > 0, 'should have at least one category');
});
