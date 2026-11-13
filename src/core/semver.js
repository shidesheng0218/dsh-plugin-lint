/**
 * A deliberately small semver range evaluator for DSH peer admission.
 *
 * The host calls `semver.satisfies(runtime, range, { includePrerelease: true })`
 * (dsh-app-boot README: "prereleases participate in range matching"). This
 * module implements the subset of node-semver that appears in plugin peer
 * declarations: exact/partial versions, = > >= < <=, ^, ~, hyphen ranges, x/*,
 * and ||. Anything outside that grammar returns 'unknown' instead of guessing:
 * a rule that cannot decide must not produce an error.
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const PARTIAL_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(text) {
  const match = VERSION_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const diff = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function version(major, minor = 0, patch = 0, prerelease = []) {
  return { major, minor, patch, prerelease };
}

function parsePartial(text) {
  const match = PARTIAL_RE.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? undefined : Number(match[2]),
    patch: match[3] === undefined ? undefined : Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function floor(partial) {
  return version(partial.major, partial.minor ?? 0, partial.patch ?? 0, partial.prerelease);
}

function nextMajor(partial) { return version(partial.major + 1, 0, 0); }
function nextMinor(partial) { return version(partial.major, (partial.minor ?? 0) + 1, 0); }
function nextPatch(partial) { return version(partial.major, partial.minor ?? 0, (partial.patch ?? 0) + 1); }

function caretBounds(partial) {
  const lower = { op: '>=', version: floor(partial) };
  let upper;
  if (partial.major > 0) upper = nextMajor(partial);
  else if ((partial.minor ?? 0) > 0) upper = nextMinor(partial);
  else upper = nextPatch(partial);
  return [lower, { op: '<', version: upper }];
}

function tildeBounds(partial) {
  const lower = { op: '>=', version: floor(partial) };
  const upper = partial.minor === undefined ? nextMajor(partial) : nextMinor(partial);
  return [lower, { op: '<', version: upper }];
}

function bareBounds(partial) {
  if (partial.major === undefined) return [];
  // A full version is exact; a partial one is the usual x-range.
  if (partial.minor !== undefined && partial.patch !== undefined) {
    return [{ op: '=', version: floor(partial) }];
  }
  const lower = { op: '>=', version: floor(partial) };
  const upper = partial.minor === undefined ? nextMajor(partial) : nextMinor(partial);
  return [lower, { op: '<', version: upper }];
}

function operatorBounds(op, partial) {
  if (partial.major === undefined) return [];
  const exact = floor(partial);
  if (op === '>=') return [{ op: '>=', version: exact }];
  if (op === '>') {
    if (partial.patch !== undefined) return [{ op: '>', version: exact }];
    if (partial.minor !== undefined) return [{ op: '>=', version: nextMinor(partial) }];
    return [{ op: '>=', version: nextMajor(partial) }];
  }
  if (op === '<') return [{ op: '<', version: exact }];
  if (op === '<=') {
    if (partial.patch !== undefined) return [{ op: '<=', version: exact }];
    if (partial.minor !== undefined) return [{ op: '<', version: nextMinor(partial) }];
    return [{ op: '<', version: nextMajor(partial) }];
  }
  if (op === '=') return bareBounds(partial);
  return null;
}

function parseComparator(token) {
  if (token === '*' || token === 'x' || token === 'X') return [];
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!match) return null;
  const op = match[1] ?? '';
  const text = match[2];
  const partial = parsePartial(text);
  if (!partial) return null;
  if (op === '^') return caretBounds(partial);
  if (op === '~') return tildeBounds(partial);
  if (op === '') return bareBounds(partial);
  return operatorBounds(op, partial);
}

function parseHyphen(left, right) {
  const a = parsePartial(left);
  const b = parsePartial(right);
  if (!a || !b || a.major === undefined || b.major === undefined) return null;
  const bounds = [{ op: '>=', version: floor(a) }];
  if (b.patch !== undefined) bounds.push({ op: '<=', version: floor(b) });
  else if (b.minor !== undefined) bounds.push({ op: '<', version: nextMinor(b) });
  else bounds.push({ op: '<', version: nextMajor(b) });
  return bounds;
}

function parseAlternative(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) return parseHyphen(hyphen[1], hyphen[2]);
  const tokens = trimmed.split(/\s+/);
  const bounds = [];
  for (const token of tokens) {
    const parsed = parseComparator(token);
    if (parsed === null) return null;
    bounds.push(...parsed);
  }
  return bounds;
}

/** true / false / null (null = outside the supported grammar). */
export function evaluateRange(text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || /^workspace:/.test(raw)) return null;
  const alternatives = raw.split('||').map(parseAlternative);
  if (alternatives.some((alt) => alt === null)) return null;
  return alternatives;
}

export function satisfies(versionText, rangeText) {
  const target = parseVersion(versionText);
  if (!target) return null;
  const alternatives = evaluateRange(rangeText);
  if (alternatives === null) return null;
  for (const bounds of alternatives) {
    let ok = true;
    for (const bound of bounds) {
      const cmp = compareVersions(target, bound.version);
      const pass = bound.op === '>' ? cmp > 0
        : bound.op === '>=' ? cmp >= 0
          : bound.op === '<' ? cmp < 0
            : bound.op === '<=' ? cmp <= 0
              : cmp === 0;
      if (!pass) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Whether a range uses only the supported grammar. */
export function isDecidableRange(text) {
  return evaluateRange(text) !== null;
}