/**
 * Tests for security deep analysis
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSecurityDeep, SECURITY_RULES } from '../src/security.js';
import { maskSource } from '../src/mask.js';

/** A file object shaped the way loadPackage produces one.
 */
const file = (path, text) => ({ path, text, ...maskSource(text) });

test('analyzeSecurityDeep - detects localStorage credential storage', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('auth.js', 'localStorage.setItem("auth_token", token);')]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(result.findings.length > 0, 'Should detect security issues');
  assert.ok(result.findings.some(f => f.rule === 'S2'), 'Should detect localStorage credential storage');
  assert.equal(result.findings.find(f => f.rule === 'S2').level, 'warn', 'heuristic rules cap at warning level');
});

test('analyzeSecurityDeep - detects eval usage', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('dangerous.js', 'eval(userInput); new Function(code)();')]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(result.findings.some(f => f.rule === 'S3'), 'Should detect eval usage');
});

test('analyzeSecurityDeep - detects innerHTML without sanitization', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: { client: 'client.js' },
    jsFiles: [file('client.js', 'element.innerHTML = userData;')]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(result.findings.some(f => f.rule === 'S4'), 'Should detect unsafe innerHTML');
});

test('analyzeSecurityDeep - detects command injection risks', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('shell.js', 'exec(`rm -rf ${userPath}`);')]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(result.findings.some(f => f.rule === 'S6'), 'Should detect command injection risk');
});

test('analyzeSecurityDeep - detects insecure HTTP', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('network.js', 'fetch("http://api.example.com/sensitive");')]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(result.findings.some(f => f.rule === 'S10'), 'Should detect insecure HTTP');
});

test('analyzeSecurityDeep - calculates risk level', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('secure.js', 'console.log("safe code");')]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(['minimal', 'low', 'medium', 'high', 'critical'].includes(result.riskLevel), 'Should have valid risk level');
  assert.equal(typeof result.summary.total, 'number', 'Should have numeric summary');
});

test('analyzeSecurityDeep - categorizes findings', () => {
  const pkg = {
    manifest: { name: 'test' },
    entries: {},
    jsFiles: [file('mixed.js', `
          localStorage.setItem("token", val);
          eval(code);
          fetch("http://example.com");
        `)]
  };

  const result = analyzeSecurityDeep(pkg);
  
  assert.ok(result.byCategory, 'Should have categorized findings');
  assert.ok(Object.keys(result.byCategory).length > 0, 'Should have at least one category');
});

console.log('✅ All security tests passed');
