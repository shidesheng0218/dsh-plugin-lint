import { readFileSync, writeFileSync } from 'node:fs';
import { sha256, stableStringify } from '../shared/hash.js';
import { RULES } from './rules.js';

export const BASELINE_SCHEMA_VERSION = 1;

/** Evidence strings can move with formatting; keep the stable part only. */
export function normalizeEvidence(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** A fingerprint deliberately excludes the line number. */
export function fingerprint(finding) {
  return 'sha256:' + sha256(stableStringify({
    rule: finding.rule,
    file: finding.file || 'package.json',
    evidence: normalizeEvidence(finding.evidence),
  }));
}

export function rulesetIdentity() {
  return {
    hash: sha256(stableStringify(RULES.map((rule) => ({ id: rule.id, level: rule.level })))),
    rules: RULES.map((rule) => rule.id),
    eventCatalog: 'src/data/event-types.json',
  };
}

export function createBaseline(reports, { generatedAt = new Date().toISOString() } = {}) {
  const seen = new Set();
  const findings = [];
  for (const report of reports) {
    for (const finding of report.findings) {
      const print = fingerprint(finding);
      if (seen.has(print)) continue;
      seen.add(print);
      findings.push({
        fingerprint: print,
        rule: finding.rule,
        level: finding.level,
        file: finding.file || 'package.json',
        evidence: normalizeEvidence(finding.evidence),
      });
    }
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generatedAt,
    ruleset: rulesetIdentity(),
    findings,
  };
}

export function readBaseline(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || value.schemaVersion !== BASELINE_SCHEMA_VERSION || !Array.isArray(value.findings)) {
    throw new Error('not a dsh-plugin-lint baseline: ' + path);
  }
  for (const entry of value.findings) {
    if (typeof entry.fingerprint !== 'string' || typeof entry.rule !== 'string') {
      throw new Error('baseline entry is missing fingerprint/rule: ' + path);
    }
  }
  return value;
}

export function writeBaseline(path, baseline) {
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
}

/** Filter baseline fingerprints out of each report and recompute its summary. */
export function applyBaseline(reports, baseline, { path } = {}) {
  const known = new Set(baseline.findings.map((entry) => entry.fingerprint));
  let suppressed = 0;
  const filtered = reports.map((report) => {
    const findings = [];
    for (const finding of report.findings) {
      if (known.has(fingerprint(finding))) suppressed += 1;
      else findings.push(finding);
    }
    const summary = { error: 0, warn: 0, info: 0 };
    for (const finding of findings) summary[finding.level] += 1;
    return { ...report, findings, summary, baseline: { suppressed: report.findings.length - findings.length, path: path || null } };
  });
  return { reports: filtered, suppressed };
}

/** Keep only baseline entries that still occur in the current run. */
export function pruneBaseline(baseline, reports, { generatedAt = baseline.generatedAt } = {}) {
  const current = new Set();
  for (const report of reports) for (const finding of report.findings) current.add(fingerprint(finding));
  return {
    ...baseline,
    generatedAt,
    ruleset: rulesetIdentity(),
    findings: baseline.findings.filter((entry) => current.has(entry.fingerprint)),
  };
}