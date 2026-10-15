import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, parseInactive } from '../scripts/lib/probe.mjs';

/**
 * classify() is the verdict vocabulary of the whole probe, so its edges are
 * pinned down directly: a composition that is "waiting for a service" must not
 * mask an entry that failed for a real reason.
 */

const waiting = { name: 'a-plugin', id: 'a-plugin', reason: 'waiting for service: webServer' };

test('a pure waiting entry is awaiting-service, not a failure', () => {
  assert.equal(classify('', [waiting], undefined), 'awaiting-service');
});

test('an Error reason is inactive-error even when another entry is only waiting', () => {
  const entries = [waiting, { name: 'b', id: 'b', reason: 'Error: boom' }];
  assert.equal(classify('', entries, undefined), 'inactive-error');
});

test('a thrown mount failure names Error in the reason, so it is caught', () => {
  // The shape the host actually prints for a throwing apply().
  const entries = [{ name: 'throws-in-apply', id: 'throws-in-apply', reason: 'Error: M4-PROBE: this plugin always fails to mount' }];
  assert.equal(classify('', entries, undefined), 'inactive-error');
});

test('a reason that failed without the word Error is still a failure, not awaiting-service', () => {
  // classify used to ask only about /Error/, so any other failure wording —
  // a timeout, a missing config — was reported as the harmless "awaiting-service".
  const entries = [waiting, { name: 'b', id: 'b', reason: 'timed out after 30000 ms' }];
  assert.equal(classify('', entries, undefined), 'inactive-error');
});

test('mixed waiting and a non-Error failure names the failing entry', () => {
  const entries = [waiting, { name: 'b', id: 'b', reason: 'configuration rejected' }];
  assert.equal(classify('', entries, undefined), 'inactive-error');
});

test('no inactive entries falls through to the sentinels', () => {
  assert.equal(classify('...MISSING_CREDENTIAL...', [], undefined), 'active');
  assert.equal(classify('nothing useful', [], undefined), 'boot-failed');
  assert.equal(classify('nothing useful', [], true), 'active');
  assert.equal(classify('nothing useful', [], false), 'boot-failed');
});

test('parseInactive reads the did-not-activate block and the stack lines under it', () => {
  const text = [
    'some boot noise',
    '2 plugins did not activate:',
    'alpha (alpha): waiting for service: webServer',
    'beta (beta): Error: boom',
    '    at Object.apply (/tmp/x/index.js:2:7)',
    'next line of output',
  ].join('\n');
  const entries = parseInactive(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].reason, 'waiting for service: webServer');
  assert.equal(entries[1].reason, 'Error: boom');
  assert.match(entries[1].detail, /at Object\.apply/);
});

// ---------------------------------------------------------------- audit

test('the audit reports observed capabilities with their call sites', async () => {
  const { probePackage } = await import('../scripts/lib/probe.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'audit-test',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  }));
  writeFileSync(join(dir, 'index.js'), 'export function apply(ctx) { ctx.slots.register({ name: "settings.section" }, () => {}); }');
  writeFileSync(join(dir, 'lib', 'worker.js'), 'import { exec } from "node:child_process"; export function run() { exec("ls"); }');
  try {
    const cell = await probePackage({ target: dir, dsh: { id: 'npm:0.2.0-rc.2', kind: 'npm', version: '0.2.0-rc.2', node: process.execPath, cli: 'unused', extraArgs: [] }, audit: true });
    const caps = cell.audit.observed.map((o) => o.capability);
    assert.ok(caps.includes('ui-injection'), 'ctx.slots.register is observed as ui-injection');
    assert.ok(caps.includes('shell'), 'exec() is observed as shell');
    const shell = cell.audit.observed.find((o) => o.capability === 'shell');
    assert.equal(shell.sites, 1, 'exec( is one shell site');
    assert.equal(shell.first.file, 'lib/worker.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a capability mentioned in a string is not observed', async () => {
  const { probePackage } = await import('../scripts/lib/probe.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'audit-test',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  }));
  // The word "fetch(" appears in a string literal, not in code.
  writeFileSync(join(dir, 'index.js'), 'export const note = "call fetch() to load data"; export function apply() {}');
  try {
    const cell = await probePackage({ target: dir, dsh: { id: 'npm:0.2.0-rc.2', kind: 'npm', version: '0.2.0-rc.2', node: process.execPath, cli: 'unused', extraArgs: [] }, audit: true });
    const caps = cell.audit.observed.map((o) => o.capability);
    assert.ok(!caps.includes('network'), 'a string mentioning fetch( is not a network call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
