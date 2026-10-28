/**
 * Composition conflict detection: finds static collisions when multiple plugins
 * compete for the same resource (slot, route, tool name, config key).
 *
 * EXPERIMENTAL. This is a cheap pre-flight scan of literal call sites. The
 * authoritative conflict data comes from the runtime matrix runner
 * (scripts/matrix/conflicts.mjs), which installs the plugins together and reads
 * what the host actually registered. This module only understands literals, so a
 * missing conflict is not proof that two plugins compose.
 *
 * @module composition
 */

import { blockAfter } from '../core/mask.js';
import { EXPERIMENTAL_SCHEMA_VERSION } from '../shared/version.js';

const LIMITS = [
  'Static scan of literal call sites: dynamic resource names are not resolved.',
  'The runtime matrix conflict check (scripts/matrix/conflicts.mjs) is the authority; this module is a pre-flight hint.',
  'A missing conflict is not proof that two plugins compose.',
];

const pluginName = (pkg) => pkg.name ?? pkg.manifest?.name ?? pkg.dir ?? 'unknown';

/**
 * Detect conflicts across a set of loaded packages.
 * @param {Array<object>} packages - objects shaped like loadPackage() results
 * @returns {object} conflict report with categories
 */
export function detectConflicts(packages) {
  const conflicts = {
    schemaVersion: EXPERIMENTAL_SCHEMA_VERSION,
    slots: [],
    toolNames: [],
    routes: [],
    unknownRoutes: [],
    configKeys: [],
    eventListeners: [],
    summary: { total: 0, high: 0, medium: 0, low: 0 },
  };

  // Track claimed resources. A plugin that mentions the same resource twice is
  // one claim, not a conflict with itself.
  const slotClaims = new Map();
  const toolClaims = new Map();
  const routeClaims = new Map();
  const configClaims = new Map();
  const waterfallListeners = new Map();

  const claim = (map, key, entry) => {
    if (!map.has(key)) map.set(key, []);
    const claims = map.get(key);
    if (!claims.some((existing) => existing.plugin === entry.plugin)) claims.push(entry);
  };

  for (const pkg of packages) {
    const name = pluginName(pkg);
    for (const slot of extractSlots(pkg)) claim(slotClaims, slot.name, { plugin: name, ...slot });
    for (const tool of extractTools(pkg)) claim(toolClaims, tool.name, { plugin: name, ...tool });
    for (const route of extractRoutes(pkg)) {
      if (route.method === 'unknown') conflicts.unknownRoutes.push({ plugin: name, ...route });
      else claim(routeClaims, route.method + ' ' + route.path, { plugin: name, ...route });
    }
    for (const cfg of extractConfigKeys(pkg)) claim(configClaims, cfg.key, { plugin: name, ...cfg });
    for (const wf of extractWaterfallListeners(pkg)) claim(waterfallListeners, wf.event, { plugin: name, ...wf });
  }

  for (const [slot, claims] of slotClaims) {
    if (claims.length > 1) {
      conflicts.slots.push({
        resource: slot,
        plugins: claims.map((c) => c.plugin),
        risk: assessSlotRisk(slot),
        resolution: suggestSlotResolution(slot, claims),
        details: claims,
      });
    }
  }

  for (const [name, claims] of toolClaims) {
    if (claims.length > 1) {
      conflicts.toolNames.push({
        resource: name,
        plugins: claims.map((c) => c.plugin),
        risk: 'high',
        resolution: 'Use unique tool names with a plugin prefix (for example "myplugin:search"). A duplicate tool name can make the later plugin fail to mount.',
        details: claims,
      });
    }
  }

  for (const [resource, claims] of routeClaims) {
    if (claims.length > 1) {
      conflicts.routes.push({
        resource,
        path: claims[0].path,
        methods: [...new Set(claims.map((claim) => claim.method))],
        plugins: claims.map((c) => c.plugin),
        risk: 'medium',
        resolution: 'Register a namespaced route instead of sharing a method and path.',
        details: claims,
      });
    }
  }

  for (const [key, claims] of configClaims) {
    if (claims.length > 1) {
      conflicts.configKeys.push({
        resource: key,
        plugins: claims.map((c) => c.plugin),
        risk: assessConfigRisk(key),
        resolution: 'Use plugin-namespaced config keys.',
        details: claims,
      });
    }
  }

  for (const [event, listeners] of waterfallListeners) {
    if (listeners.length < 2) continue;
    const problematic = listeners.filter((listener) => listener.mayFallThrough);
    if (problematic.length === 0) continue;
    conflicts.eventListeners.push({
      resource: event,
      plugins: listeners.map((listener) => listener.plugin),
      risk: 'medium',
      resolution: 'Check listener order and preserve next(): a waterfall listener that neither returns next() nor rejects deliberately can swallow the decision.',
      problematic: problematic.map((entry) => entry.plugin),
      details: listeners,
    });
  }

  const allConflicts = [
    ...conflicts.slots,
    ...conflicts.toolNames,
    ...conflicts.routes,
    ...conflicts.configKeys,
    ...conflicts.eventListeners,
  ];

  conflicts.summary.total = allConflicts.length;
  for (const conflict of allConflicts) {
    if (conflict.risk === 'high') conflicts.summary.high++;
    else if (conflict.risk === 'medium') conflicts.summary.medium++;
    else conflicts.summary.low++;
  }

  conflicts.experimental = true;
  conflicts.limits = LIMITS;
  return conflicts;
}

/** Extract UI slot registrations from package code (literal names only). */
function extractSlots(pkg) {
  const slots = [];
  const patterns = [
    // Current API: ctx.slots.inject('<slot>', () => ctx.slots.register({ name: '<slot>', ... }))
    /ctx\s*\.\s*slots\s*\.\s*inject\s*\(\s*['"]([^'"]+)['"]/g,
    /ctx\s*\.\s*slots\s*\.\s*register\s*\(\s*\{[^}]*?\bname\s*:\s*['"]([^'"]+)['"]/g,
    // Older/alternate shapes still seen in community plugins.
    /\bslot\s*:\s*['"]([^'"]+)['"]/g,
    /ctx\s*\.\s*provide\s*\(\s*['"]ui\.slot\.([^'"]+)['"]/g,
  ];

  for (const file of pkg.jsFiles) {
    const view = file.masked ?? file.text;
    patterns.forEach((pattern, index) => {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(view)) !== null) {
        slots.push({
          name: index === 3 ? 'ui.slot.' + m[1] : m[1],
          file: file.path,
          line: lineOfMatch(file.lineStarts, m.index),
        });
      }
    });
  }

  return slots;
}

/** Extract tool definitions (literal names only). */
function extractTools(pkg) {
  const tools = [];
  const patterns = [
    // Current API: ctx.tools.register(defineTool({ name: '...' })) or the object form.
    /ctx\s*\.\s*tools\s*\.\s*register\s*\(\s*(?:defineTool\s*\(\s*)?\{[^}]*?\bname\s*:\s*['"]([^'"]+)['"]/g,
    // Declarative arrays: tools: [{ name: '...' }]
    /tools\s*:\s*\[[^\]]*?\{[^}]*?\bname\s*:\s*['"]([^'"]+)['"]/g,
  ];

  for (const file of pkg.jsFiles) {
    const view = file.masked ?? file.text;
    patterns.forEach((pattern) => {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(view)) !== null) {
        tools.push({ name: m[1], file: file.path, line: lineOfMatch(file.lineStarts, m.index) });
      }
    });
  }

  return tools;
}

function extractRoutes(pkg) {
  const routes = [];
  const fetchPattern = /\bconnection\s*\.\s*fetch\s*\.\s*register\s*\(\s*\{([^}]+)\}/g;
  const routerPattern = /ctx\s*\.\s*router\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;

  for (const file of pkg.jsFiles) {
    const view = file.masked ?? file.text;
    let match;
    while ((match = fetchPattern.exec(view)) !== null) {
      const body = match[1];
      const path = /\bpath\s*:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
      if (!path) continue;
      const methodsBlock = /\bmethods\s*:\s*\[([^\]]*)\]/.exec(body)?.[1];
      const singular = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/.exec(body)?.[1];
      const methods = methodsBlock === undefined
        ? (singular ? [singular] : [])
        : [...methodsBlock.matchAll(/['"]([A-Za-z]+)['"]/g)].map((entry) => entry[1]);
      const location = { file: file.path, line: lineOfMatch(file.lineStarts, match.index) };
      if (methods.length === 0) routes.push({ path, method: 'unknown', ...location });
      for (const method of methods) routes.push({ path, method: method.toUpperCase(), ...location });
    }
    while ((match = routerPattern.exec(view)) !== null) {
      routes.push({ path: match[2], method: match[1].toUpperCase(), file: file.path, line: lineOfMatch(file.lineStarts, match.index) });
    }
  }

  return routes;
}

/** Extract config key accesses (literal keys only). */
function extractConfigKeys(pkg) {
  const keys = [];
  const setPattern = /ctx\s*\.\s*config\s*\.\s*set\s*\(\s*['"]([^'"]+)['"]/g;

  for (const file of pkg.jsFiles) {
    const view = file.masked ?? file.text;
    setPattern.lastIndex = 0;
    let m;
    while ((m = setPattern.exec(view)) !== null) {
      keys.push({ key: m[1], file: file.path, line: lineOfMatch(file.lineStarts, m.index), operation: 'set' });
    }
  }

  return keys;
}

function extractWaterfallListeners(pkg) {
  const listeners = [];
  const waterfallEvents = new Set([
    'agent/pre-step',
    'agent/request',
    'llm/stream',
    'tools/pre-execute',
    'tools/execute',
    'tools/post-execute',
  ]);
  const onPattern = /ctx\s*\.\s*on\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{/g;

  for (const file of pkg.jsFiles) {
    const view = file.masked ?? file.text;
    const structural = file.structural ?? view;
    let m;
    while ((m = onPattern.exec(view)) !== null) {
      const event = m[1];
      if (!waterfallEvents.has(event)) continue;
      const block = blockAfter(structural, m.index);
      if (!block) continue;
      const hasDecision = /\bthrow\s+|\breturn\s*[^;\s}]/.test(block.body);
      listeners.push({
        event,
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index),
        mayFallThrough: !hasDecision,
      });
    }
  }

  return listeners;
}

/** Assess risk level for a slot collision (heuristic). */
function assessSlotRisk(slotName) {
  // Slots designed for several providers are expected to be claimed more than once.
  if (slotName === 'settings.section' || slotName === 'conversation.chat.node') return 'low';
  return 'medium';
}

/** Assess config key collision risk. */
function assessConfigRisk(key) {
  if (!key.includes('.')) return 'high';
  if (key.startsWith('theme.') || key.startsWith('appearance.')) return 'low';
  return 'medium';
}

/** Suggest a resolution for a slot collision. */
function suggestSlotResolution(slotName, claims) {
  if (claims.length === 2) {
    return 'Two plugins claim "' + slotName + '": ' + claims.map((c) => c.plugin).join(', ') + '. Check whether both are meant to render there.';
  }
  return claims.length + ' plugins claim "' + slotName + '"; review which should render where.';
}

/** Find the line number of a regex match index. */
function lineOfMatch(lineStarts, index) {
  if (!lineStarts || lineStarts.length === 0) return 1;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i] > index) return i;
  }
  return lineStarts.length;
}
