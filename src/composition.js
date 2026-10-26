/**
 * Composition conflict detection: finds collisions when multiple plugins
 * compete for the same resource (slot, route, tool name, config key).
 *
 * @module composition
 */

import { maskSource } from './mask.js';

/**
 * Detect conflicts across a set of loaded packages.
 * @param {Array<{name: string, manifest: object, jsFiles: Array}>} packages
 * @returns {object} conflict report with categories
 */
export function detectConflicts(packages) {
  const conflicts = {
    slots: [],
    toolNames: [],
    routes: [],
    configKeys: [],
    eventListeners: [],
    summary: { total: 0, high: 0, medium: 0, low: 0 }
  };

  // Track claimed resources
  const slotClaims = new Map();
  const toolClaims = new Map();
  const routeClaims = new Map();
  const configClaims = new Map();
  const waterfallListeners = new Map();

  for (const pkg of packages) {
    // 1. UI Slot collisions
    const slots = extractSlots(pkg);
    for (const slot of slots) {
      if (!slotClaims.has(slot.name)) slotClaims.set(slot.name, []);
      slotClaims.get(slot.name).push({ plugin: pkg.name, ...slot });
    }

    // 2. Tool name duplicates
    const tools = extractTools(pkg);
    for (const tool of tools) {
      if (!toolClaims.has(tool.name)) toolClaims.set(tool.name, []);
      toolClaims.get(tool.name).push({ plugin: pkg.name, ...tool });
    }

    // 3. Route conflicts
    const routes = extractRoutes(pkg);
    for (const route of routes) {
      if (!routeClaims.has(route.path)) routeClaims.set(route.path, []);
      routeClaims.get(route.path).push({ plugin: pkg.name, ...route });
    }

    // 4. Config key overwrites
    const configs = extractConfigKeys(pkg);
    for (const cfg of configs) {
      if (!configClaims.has(cfg.key)) configClaims.set(cfg.key, []);
      configClaims.get(cfg.key).push({ plugin: pkg.name, ...cfg });
    }

    // 5. Waterfall listener ordering issues
    const waterfalls = extractWaterfallListeners(pkg);
    for (const wf of waterfalls) {
      if (!waterfallListeners.has(wf.event)) waterfallListeners.set(wf.event, []);
      waterfallListeners.get(wf.event).push({ plugin: pkg.name, ...wf });
    }
  }

  // Generate conflict reports
  for (const [slot, claims] of slotClaims) {
    if (claims.length > 1) {
      conflicts.slots.push({
        resource: slot,
        plugins: claims.map(c => c.plugin),
        risk: assessSlotRisk(slot, claims),
        resolution: suggestSlotResolution(slot, claims),
        details: claims
      });
    }
  }

  for (const [name, claims] of toolClaims) {
    if (claims.length > 1) {
      conflicts.toolNames.push({
        resource: name,
        plugins: claims.map(c => c.plugin),
        risk: 'high', // Tool name collision breaks routing
        resolution: 'Use unique tool names with plugin prefix (e.g., "myplugin:search")',
        details: claims
      });
    }
  }

  for (const [path, claims] of routeClaims) {
    if (claims.length > 1) {
      conflicts.routes.push({
        resource: path,
        plugins: claims.map(c => c.plugin),
        risk: 'medium',
        resolution: 'Last registered wins; consider namespaced routes',
        details: claims
      });
    }
  }

  for (const [key, claims] of configClaims) {
    if (claims.length > 1) {
      conflicts.configKeys.push({
        resource: key,
        plugins: claims.map(c => c.plugin),
        risk: assessConfigRisk(key),
        resolution: 'Use plugin-namespaced config keys',
        details: claims
      });
    }
  }

  for (const [event, listeners] of waterfallListeners) {
    if (listeners.length > 1) {
      const problematic = listeners.filter(l => l.mayNotReturnNext);
      if (problematic.length > 0) {
        conflicts.eventListeners.push({
          resource: event,
          plugins: listeners.map(l => l.plugin),
          risk: 'high',
          resolution: 'Ensure all waterfall listeners return next() to avoid blocking other plugins',
          problematic: problematic.map(p => p.plugin),
          details: listeners
        });
      }
    }
  }

  // Calculate summary
  const allConflicts = [
    ...conflicts.slots,
    ...conflicts.toolNames,
    ...conflicts.routes,
    ...conflicts.configKeys,
    ...conflicts.eventListeners
  ];

  conflicts.summary.total = allConflicts.length;
  for (const c of allConflicts) {
    if (c.risk === 'high') conflicts.summary.high++;
    else if (c.risk === 'medium') conflicts.summary.medium++;
    else conflicts.summary.low++;
  }

  return conflicts;
}

/** Extract UI slot registrations from package code */
function extractSlots(pkg) {
  const slots = [];
  const slotPattern = /\bslot\s*:\s*['"]([^'"]+)['"]/g;
  const providePattern = /ctx\s*\.\s*provide\s*\(\s*['"]ui\.slot\.([^'"]+)['"]/g;

  for (const file of pkg.jsFiles) {
    let m;
    while ((m = slotPattern.exec(file.masked)) !== null) {
      slots.push({
        name: m[1],
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index)
      });
    }
    while ((m = providePattern.exec(file.masked)) !== null) {
      slots.push({
        name: 'ui.slot.' + m[1],
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index)
      });
    }
  }

  return slots;
}

/** Extract tool definitions */
function extractTools(pkg) {
  const tools = [];
  // ctx.tools.register({ name: "..." })
  const registerPattern = /ctx\s*\.\s*tools\s*\.\s*register\s*\(\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/g;
  // tools: [{ name: "..." }]
  const arrayPattern = /tools\s*:\s*\[[^\]]*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/g;

  for (const file of pkg.jsFiles) {
    let m;
    while ((m = registerPattern.exec(file.masked)) !== null) {
      tools.push({
        name: m[1],
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index)
      });
    }
    while ((m = arrayPattern.exec(file.masked)) !== null) {
      tools.push({
        name: m[1],
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index)
      });
    }
  }

  return tools;
}

/** Extract route registrations */
function extractRoutes(pkg) {
  const routes = [];
  // ctx.router.get('/path', ...)
  const routerPattern = /ctx\s*\.\s*router\s*\.\s*(?:get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;

  for (const file of pkg.jsFiles) {
    let m;
    while ((m = routerPattern.exec(file.masked)) !== null) {
      routes.push({
        path: m[1],
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index)
      });
    }
  }

  return routes;
}

/** Extract config key accesses */
function extractConfigKeys(pkg) {
  const keys = [];
  // ctx.config.set('key', ...)
  const setPattern = /ctx\s*\.\s*config\s*\.\s*set\s*\(\s*['"]([^'"]+)['"]/g;

  for (const file of pkg.jsFiles) {
    let m;
    while ((m = setPattern.exec(file.masked)) !== null) {
      keys.push({
        key: m[1],
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index),
        operation: 'set'
      });
    }
  }

  return keys;
}

/** Extract waterfall event listeners and check if they return next() */
function extractWaterfallListeners(pkg) {
  const listeners = [];
  const waterfallEvents = [
    'agent/pre-step',
    'agent/request',
    'llm/stream',
    'tools/pre-execute',
    'tools/execute',
    'tools/post-execute'
  ];

  // More flexible pattern to catch various arrow function styles
  const onPattern = /ctx\s*\.\s*on\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>\s*\{/g;

  for (const file of pkg.jsFiles) {
    let m;
    while ((m = onPattern.exec(file.text)) !== null) {
      const event = m[1];
      if (!waterfallEvents.includes(event)) continue;

      const startIdx = file.text.indexOf('{', m.index);
      if (startIdx === -1) continue;
      
      const fnBody = extractFunctionBody(file.text, startIdx + 1);
      const hasReturnNext = /return\s+next\s*\(/.test(fnBody);

      listeners.push({
        event,
        file: file.path,
        line: lineOfMatch(file.lineStarts, m.index),
        mayNotReturnNext: !hasReturnNext
      });
    }
  }

  return listeners;
}

/** Assess risk level for slot collision */
function assessSlotRisk(slotName, claims) {
  // Critical slots that should never collide
  const criticalSlots = ['ui.slot.sidebar', 'ui.slot.panel', 'ui.slot.toolbar'];
  if (criticalSlots.includes(slotName)) return 'high';
  
  // Extension slots often designed for multiple providers
  if (slotName.includes('extension')) return 'low';
  
  return 'medium';
}

/** Assess config key collision risk */
function assessConfigRisk(key) {
  // Top-level global keys are high risk
  if (!key.includes('.') || key.split('.').length === 1) return 'high';
  
  // Theme/appearance keys often overwrite intentionally
  if (key.startsWith('theme.') || key.startsWith('appearance.')) return 'low';
  
  return 'medium';
}

/** Suggest resolution for slot collision */
function suggestSlotResolution(slotName, claims) {
  if (claims.length === 2) {
    return `Consider disabling one of: ${claims.map(c => c.plugin).join(', ')}`;
  }
  return `${claims.length} plugins competing for "${slotName}"; review which should take priority`;
}

/** Extract function body from source, handling nested braces */
function extractFunctionBody(source, startIdx) {
  let depth = 1;
  let idx = startIdx;
  while (idx < source.length && depth > 0) {
    const char = source[idx];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    idx++;
  }
  return source.slice(startIdx, idx);
}

/** Find line number of a regex match index */
function lineOfMatch(lineStarts, index) {
  if (!lineStarts || lineStarts.length === 0) return 1;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i] > index) return i;
  }
  return lineStarts.length;
}
