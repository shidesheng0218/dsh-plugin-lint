import { readFileSync, writeFileSync } from 'node:fs';
import { sha256, stableStringify } from '../shared/hash.js';
import { EVENT_CATALOG, RULES } from './rules.js';

export const BASELINE_SCHEMA_VERSION = 1;

/** Evidence strings can move with formatting; keep the stable part only. */
export function normalizeEvidence(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** A fingerprint excludes the line number and can optionally be package-scoped. */
export function fingerprint(finding, packageName) {
  return 'sha256:' + sha256(stableStringify({
    ...(packageName === undefined ? {} : { package: packageName }),
    rule: finding.rule,
    file: finding.file || 'package.json',
    evidence: normalizeEvidence(finding.evidence),
  }));
}

function assertLegacyScope(baseline, reports) {
  if (reports.length !== 1 && baseline.findings.some((entry) => entry.package === undefined)) {
    throw new Error('baseline entries without package identity require a single package; regenerate the baseline for multiple packages');
  }
}

export function rulesetIdentity() {
  return {
    hash: sha256(stableStringify(RULES.map((rule) => ({ id: rule.id, level: rule.level })))),
    rules: RULES.map((rule) => rule.id),
    eventCatalog: { harvestedAt: EVENT_CATALOG.harvestedAt, dshVersions: EVENT_CATALOG.dshVersions },
  };
}

export function createBaseline(reports, { generatedAt = new Date().toISOString() } = {}) {
  const seen = new Set();
  const findings = [];
  for (const report of reports) {
    const packageName = report.target.name;
    for (const finding of report.findings) {
      const print = fingerprint(finding, packageName);
      const key = packageName + '\0' + print;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        fingerprint: print,
        package: packageName,
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
    if (entry.package !== undefined && (typeof entry.package !== 'string' || entry.package.length === 0)) {
      throw new Error('baseline entry has an invalid package: ' + path);
    }
  }
  return value;
}

export function writeBaseline(path, baseline) {
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
}

/** Filter baseline fingerprints out of each report and recompute its summary. */
export function applyBaseline(reports, baseline, { path } = {}) {
  assertLegacyScope(baseline, reports);
  const scoped = new Set(baseline.findings.filter((entry) => entry.package !== undefined)
    .map((entry) => entry.package + '\0' + entry.fingerprint));
  const legacy = new Set(baseline.findings.filter((entry) => entry.package === undefined)
    .map((entry) => entry.fingerprint));
  let suppressed = 0;
  const filtered = reports.map((report) => {
    const findings = [];
    const packageName = report.target.name;
    for (const finding of report.findings) {
      const scopedMatch = scoped.has(packageName + '\0' + fingerprint(finding, packageName));
      if (scopedMatch || legacy.has(fingerprint(finding))) suppressed += 1;
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
  assertLegacyScope(baseline, reports);
  const scoped = new Set();
  const legacy = new Set();
  for (const report of reports) {
    const packageName = report.target.name;
    for (const finding of report.findings) {
      scoped.add(packageName + '\0' + fingerprint(finding, packageName));
      legacy.add(fingerprint(finding));
    }
  }
  return {
    ...baseline,
    generatedAt,
    ruleset: rulesetIdentity(),
    findings: baseline.findings.filter((entry) => entry.package === undefined
      ? legacy.has(entry.fingerprint)
      : scoped.has(entry.package + '\0' + entry.fingerprint)),
  };
}