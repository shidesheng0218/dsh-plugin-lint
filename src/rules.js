import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendCallSites, blockAfter, braceDepthAt, lineOfIndex, stringAfter } from './mask.js';
import { filesCover } from './load.js';

const CATALOG = JSON.parse(readFileSync(new URL('./data/event-types.json', import.meta.url), 'utf8'));
export const EVENT_TYPES = new Set(CATALOG.types);

/** Upstream documents that ship inside a DSH installation. */
export const DOC = {
  practices: 'dsh plugin-development / references/practices.md',
  host: 'dsh plugin-development / references/host-plugin.md',
  ui: 'dsh plugin-development / references/ui-plugin.md',
};

const EVENT_TYPE_RE = /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/;
const HARNESS_CLIENT_PKG = /@deepseek-ai\/dsh-client[a-z0-9-]*/g;

export const RULES = [
  {
    id: 'E1',
    level: 'error',
    title: 'appends a session event type that appears nowhere in the official packages',
    doc: DOC.practices,
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        for (const site of appendCallSites(file.masked, file.strings)) {
          if (!EVENT_TYPE_RE.test(site.type)) continue;
          if (EVENT_TYPES.has(site.type)) continue;
          push({
            file: file.path,
            line: site.line,
            message: 'session.append("' + site.type + '", ...): this type does not appear anywhere in the official Harness packages (' + EVENT_TYPES.size + ' types observed).',
            evidence: '.append("' + site.type + '", ...)',
            hint: 'The reference asks plugins not to append session events with a new type: a live Session.append() cannot set ignorable: true, so a log holding an unknown type can refuse to reopen. The allowlist is harvested, not authoritative — if this type is legitimate, it is a gap in the rule, not in your plugin.',
          });
        }
      }
    },
  },

  {
    id: 'E2',
    level: 'error',
    title: 'client bundle factory id matches nothing the loader can ask for',
    doc: DOC.ui,
    check(ctx, options, push) {
      if (ctx.entries.client === undefined || !ctx.exists(ctx.entries.client)) return;
      const file = ctx.byPath(ctx.entries.client);
      if (!file) return;

      // The loader keys the browser module table by an id and throws when a bundle
      // registers a different one (dsh-client-modules: "bundle … loaded without
      // registering \"id\""). What it asks for is either the package name or a row
      // name from the plugin's own patch, so both are acceptable. Asserting only the
      // package name produced a false accusation against @roarpeng/graphflow, whose
      // patch mounts the row "@roarpeng/graphflow/dsh".
      const acceptable = new Set();
      if (ctx.manifest.name) acceptable.add(ctx.manifest.name);
      const patchRows = [];
      if (ctx.entries.patch !== undefined && ctx.exists(ctx.entries.patch)) {
        const patch = ctx.text(ctx.entries.patch) || '';
        for (const m of patch.matchAll(/^\s*name:\s*['"]?([^'"\s#]+)['"]?/gm)) {
          acceptable.add(m[1]);
          patchRows.push(m[1]);
        }
      }

      const re = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*/g;
      let m;
      while ((m = re.exec(file.masked)) !== null) {
        const s = stringAfter(file.strings, m.index + m[0].length, 8);
        if (!s || acceptable.has(s.value)) continue;
        push({
          file: file.path,
          line: s.line,
          message: 'factory id "' + s.value + '" is neither the package name "' + ctx.manifest.name + '" nor a row name in ' + (ctx.entries.patch || 'the bundle patch') + (patchRows.length ? ' (' + [...new Set(patchRows)].join(', ') + ')' : '') + '.',
          evidence: '__ModuleLoader__.load({ id: "' + s.value + '" })',
          hint: 'The browser module table keys the factory by the id it asks for and the loader throws when a bundle registers another one, leaving the client half unreachable.',
        });
      }
    },
  },

  {
    id: 'E3',
    level: 'error',
    title: 'manifest references a file that is not in the package',
    doc: DOC.host,
    check(ctx, options, push) {
      const declared = [
        ['host entry', ctx.entries.host, 'manifest.main or exports["."]'],
        ['client entry', ctx.entries.client, 'exports["./client"]'],
        ['bundle patch', ctx.entries.patch, 'dsh.bundle.patch'],
        ['icon', ctx.entries.icon, 'icon'],
      ];
      for (const [label, rel, source] of declared) {
        if (rel === undefined) continue;
        if (ctx.exists(rel)) continue;
        push({
          file: 'package.json',
          line: manifestLine(ctx.manifestText, source),
          message: label + ' points at "' + rel + '", which does not exist.',
          evidence: source + ' -> ' + rel,
          hint: 'Management pages read these paths without activating the plugin; a missing file is reported as a broken package.',
        });
      }
    },
  },

  {
    id: 'E4',
    level: 'error',
    title: 'declares a client half without a client entry',
    doc: DOC.ui,
    check(ctx, options, push) {
      const hasClientSection = Boolean(ctx.manifest.dsh && ctx.manifest.dsh.client);
      if (!hasClientSection) return;
      if (ctx.entries.client !== undefined && ctx.exists(ctx.entries.client)) return;
      push({
        file: 'package.json',
        line: manifestLine(ctx.manifestText, 'dsh.client'),
        message: 'dsh.client is declared but exports["./client"] does not resolve to a file.',
        evidence: 'dsh.client present, no ./client export',
        hint: 'The platform resolves the browser artifact through the ./client export.',
      });
    },
  },

  {
    id: 'E5',
    level: 'error',
    title: 'published files omit an artifact the manifest depends on',
    doc: DOC.host,
    check(ctx, options, push) {
      if (ctx.files === undefined || ctx.files.length === 0) return;
      const artifacts = [
        ['host entry', ctx.entries.host],
        ['client entry', ctx.entries.client],
        ['bundle patch', ctx.entries.patch],
        ['icon', ctx.entries.icon],
      ];
      for (const [label, rel] of artifacts) {
        if (rel === undefined || !ctx.exists(rel)) continue;
        if (filesCover(ctx.files, rel)) continue;
        push({
          file: 'package.json',
          line: manifestLine(ctx.manifestText, '"files"'),
          message: label + ' "' + rel + '" is not covered by "files", so it is absent from the published tarball.',
          evidence: 'files: ' + JSON.stringify(ctx.files),
          hint: 'This class of bug passes local testing and only appears after publish.',
        });
      }
    },
  },

  {
    id: 'W1',
    level: 'warn',
    title: 'couples the plugin to a Harness Client package',
    doc: DOC.ui,
    check(ctx, options, push) {
      // First-party packages ship in the same release as the browser module table,
      // so the coupling this rule warns about does not apply to them. Measured on
      // 2026-10-13: every official client bundle loads ui-primitives / store / slots.
      if (/^@deepseek-ai\//.test(ctx.manifest.name || '')) return;

      // One finding per surface, not per package: a plugin that lists six client
      // packages is one decision to review, not six defects.
      const loaded = new Map();
      if (ctx.entries.client !== undefined && ctx.exists(ctx.entries.client)) {
        const file = ctx.byPath(ctx.entries.client);
        if (file) {
          const re = /(?:from\s*|require\s*\(\s*|[A-Za-z_$][\w$]*\s*\(\s*)["'](@deepseek-ai\/dsh-client[a-z0-9-]*)["']/g;
          let m;
          while ((m = re.exec(file.masked)) !== null) {
            if (loaded.has(m[1])) continue;
            loaded.set(m[1], { line: file.strings.find((s) => s.start >= m.index && s.start - m.index < 80)?.line, evidence: m[0].trim() });
          }
        }
      }
      if (loaded.size > 0) {
        const first = loaded.values().next().value;
        push({
          file: ctx.entries.client,
          line: first.line,
          message: 'loads ' + loaded.size + ' Harness Client package' + (loaded.size === 1 ? '' : 's') + ' from the browser module table: ' + [...loaded.keys()].join(', ') + '.',
          evidence: first.evidence,
          hint: 'The reference advises copying the primitive instead: these packages change without notice and a throwing component blanks the slot. Official first-party bundles do the same, so treat this as a coupling risk to watch at upgrade time, not as a defect.',
        });
      }

      const coupled = [];
      for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(ctx.manifest[depField] || {})) {
          if (/^@deepseek-ai\/dsh-client/.test(name)) coupled.push(depField + ':' + name);
        }
      }
      if (coupled.length > 0) {
        push({
          file: 'package.json',
          line: 1,
          message: 'declares ' + coupled.length + ' Harness Client package dependenc' + (coupled.length === 1 ? 'y' : 'ies') + ': ' + coupled.join(', ') + '.',
          evidence: coupled.join(' '),
          hint: 'dsh.client.inject entries only order activation and stay allowed; a dependency means the code loads it.',
        });
      }
    },
  },

  {
    id: 'W2',
    level: 'warn',
    title: 'folds session state by rescanning the log',
    doc: DOC.practices,
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        const registration = file.strings.find((s) => s.value === 'session/event');
        if (registration === undefined) continue;
        if (file.masked.includes('sessionProjections')) continue;
        // Scope the check to the listener body: another object's `.events` in the
        // same file is not a rescan. (Measured against official packages.)
        const block = blockAfter(file.structural, registration.end);
        if (block === undefined) continue;
        const rescans = /\.events\b/.test(block.body) || /eventsBackwards\s*\(/.test(block.body);
        if (!rescans) continue;
        push({
          file: file.path,
          line: registration.line,
          message: 'subscribes to session/event and reads the whole event log.',
          evidence: "ctx.on('session/event', ...) with a full-log read",
          hint: 'A ctx.sessionProjections unit folds events incrementally and returns the same reference for ignored events; per-event rescans cost the whole session on every append.',
        });
      }
    },
  },

  {
    id: 'W3',
    level: 'info',
    title: 'creates a timer with no visible owner (review hint)',
    doc: DOC.practices,
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        // Only timers at module top level are unambiguous leaks: a timer created
        // inside a request handler may well be cleared by the surrounding code.
        const re = /set(Interval|Timeout)\s*\(/g;
        let m;
        while ((m = re.exec(file.structural)) !== null) {
          if (braceDepthAt(file.structural, m.index) !== 0) continue;
          push({
            file: file.path,
            line: lineOfIndex(file.lineStarts, m.index),
            message: 'appears to start a timer outside any function scope, with no context effect nearby.',
            evidence: m[0],
            hint: 'Registration on a context owns its cleanup: unload and hot reload dispose what the effect returned. Brace depth is approximate on bundled or minified output, so confirm this one by reading the code.',
          });
          break;
        }
      }
    },
  },

  {
    id: 'I1',
    level: 'info',
    title: 'declares no DSH compatibility range',
    doc: DOC.host,
    check(ctx, options, push) {
      const declared = ctx.manifest.dsh && ctx.manifest.dsh.compatibility && ctx.manifest.dsh.compatibility.dshReleases;
      if (declared && Object.keys(declared).length > 0) {
        if (options.dshVersion && !(options.dshVersion in declared)) {
          push({
            file: 'package.json',
            line: manifestLine(ctx.manifestText, 'dshReleases'),
            message: 'does not list the running DSH version "' + options.dshVersion + '" in dsh.compatibility.dshReleases.',
            evidence: 'declared: ' + Object.keys(declared).join(', '),
            hint: 'An unlisted version is unknown, not incompatible: verify it before publishing a compatibility claim.',
          });
        }
        return;
      }
      push({
        file: 'package.json',
        line: manifestLine(ctx.manifestText, '"dsh"'),
        message: 'has no dsh.compatibility.dshReleases entry.',
        evidence: 'dsh.compatibility absent',
        hint: 'Most published plugins omit this today, which is why empirical verification matters more than self-declaration.',
      });
    },
  },

  {
    id: 'I2',
    level: 'info',
    title: 'ships no display metadata',
    doc: DOC.host,
    check(ctx, options, push) {
      if (ctx.entries.icon === undefined) {
        push({
          file: 'package.json',
          line: 1,
          message: 'declares no top-level "icon".',
          evidence: 'icon absent',
          hint: 'Management cards and the settings inventory read title, description and icon without activating the plugin.',
        });
      }
      const dir = ctx.entries.localeDir;
      if (dir === undefined) {
        push({
          file: 'package.json',
          line: 1,
          message: 'ships no locale/<lang>.json metadata.',
          evidence: 'locale/ absent',
          hint: 'Title and description live under the "meta" key of locale/en.json, not in package.json.',
        });
        return;
      }
      const candidates = ctx.localeFiles();
      const withMeta = candidates.filter((c) => c.meta && (c.meta.title || c.meta.description));
      if (withMeta.length === 0) {
        push({
          file: dir + '/',
          line: 1,
          message: 'locale files declare no "meta" title or description.',
          evidence: 'locale files: ' + candidates.length,
          hint: 'Expected shape: { "meta": { "title": "...", "description": "..." } }.',
        });
      }
    },
  },

  {
    id: 'I3',
    level: 'warn',
    title: 'locale metadata is not published',
    doc: DOC.host,
    check(ctx, options, push) {
      const dir = ctx.entries.localeDir;
      if (dir === undefined) return;
      const exported = Object.keys(ctx.manifest.exports || {}).some((k) => k.includes('locale'));
      if (!exported) {
        push({
          file: 'package.json',
          line: manifestLine(ctx.manifestText, '"exports"'),
          message: 'a locale/ directory exists but exports declares no locale subpath.',
          evidence: 'exports: ' + JSON.stringify(Object.keys(ctx.manifest.exports || {})),
          hint: 'Display metadata is read through the locale subpath.',
        });
      }
      if (ctx.files && ctx.files.length > 0 && !filesCover(ctx.files, dir + '/en.json')) {
        push({
          file: 'package.json',
          line: manifestLine(ctx.manifestText, '"files"'),
          message: 'locale files are not covered by "files".',
          evidence: 'files: ' + JSON.stringify(ctx.files),
          hint: 'Metadata missing from the tarball shows as a fallback title and default artwork.',
        });
      }
    },
  },
];

function manifestLine(text, needle) {
  if (!text || !needle) return 1;
  const idx = text.indexOf(needle.replace(/^"|"$/g, ''));
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

export function localeMeta(dir, localeDir) {
  const out = [];
  for (const lang of ['en', 'zh', 'zh-CN', 'ja', 'ru']) {
    const p = join(dir, localeDir, lang + '.json');
    if (!existsSync(p)) continue;
    try { out.push({ lang, ...JSON.parse(readFileSync(p, 'utf8')) }); } catch { /* ignored: malformed locale file */ }
  }
  return out;
}
