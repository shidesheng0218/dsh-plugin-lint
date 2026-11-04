import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROUTE = '/api/dsh-plugin-lint/panel';
const generatedAt = '2026-10-01T00:00:00.000Z';
const sourceRunId = 'run-123';

function loadClient() {
  let registration;
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load: (value) => { registration = value; },
      },
    },
  });
  vm.runInNewContext(readFileSync(new URL('../panel/client.js', import.meta.url), 'utf8'), context);
  return { context, factory: registration.factory };
}

function matrix(overrides = {}) {
  return {
    hasPerPluginData: true,
    plugins: 1,
    generatedAt,
    sourceRunId,
    dshVersions: ['0.2.0-rc.2'],
    ecosystem: { versions: { '0.2.0-rc.2': { active: 1 } } },
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    schemaVersion: 2,
    checkedAt: generatedAt,
    summary: { total: 1 },
    matrix: matrix(),
    conflicts: { tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] } },
    rows: [{ name: 'demo', version: '1.0.0', health: { state: 'recorded-active' }, cells: [] }],
    ...overrides,
  };
}

test('recorded-active is recorded history, never a live healthy count', () => {
  const { context } = loadClient();
  const model = context.buildPanelModel(payload());
  assert.equal(model.counts.recorded, 1);
  assert.equal(model.counts.healthy, undefined);
  assert.equal(model.issues.length, 0);
});

test('aggregate-only data still produces an ecosystem view', () => {
  const { context } = loadClient();
  const model = context.buildPanelModel(payload({
    summary: { total: 0 },
    rows: [],
    matrix: matrix({ hasPerPluginData: false, plugins: 50 }),
  }));
  assert.equal(model.hasPerPluginData, false);
  assert.equal(model.ecosystem.plugins, 50);
  assert.equal(model.ecosystem.generatedAt, generatedAt);
  assert.equal(model.ecosystem.sourceRunId, sourceRunId);
  assert.deepEqual(model.ecosystem.tallies['0.2.0-rc.2'], { active: 1 });
});

test('conflicts and compositions enter the view model without being flattened', () => {
  const { context } = loadClient();
  const data = payload({
    rows: [{
      name: 'demo', version: '1.0.0', health: { state: 'recorded-active' },
      cells: [{ dsh: '0.2.0-rc.2', composition: 'headless', status: 'awaiting-service' }, { dsh: '0.2.0-rc.2', composition: 'web', status: 'active' }],
    }],
    conflicts: {
      tools: [{ resource: 'shared', plugins: ['a', 'b'], status: 'candidate' }],
      slots: [{ resource: 'sidebar', plugins: ['a', 'b'], status: 'candidate' }],
      routes: [{ resource: 'GET /api/x', plugins: ['a', 'b'], status: 'candidate' }],
      verified: { tools: [], slots: [], routes: [] },
    },
  });
  const model = context.buildPanelModel(data);
  assert.equal(model.conflicts.tools.length, 1);
  assert.equal(model.conflicts.slots.length, 1);
  assert.equal(model.conflicts.routes.length, 1);
  assert.deepEqual(model.rows[0].cells.map((cell) => cell.composition), ['headless', 'web']);
});

function createHooks() {
  const states = [];
  const effects = [];
  let index = 0;
  const React = {
    Fragment: 'fragment',
    Component: class {},
    useState(initial) {
      const slot = index++;
      if (!(slot in states)) states[slot] = initial;
      const setState = (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; };
      return [states[slot], setState];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in states)) states[slot] = { current: initial };
      return states[slot];
    },
    useEffect(callback) { effects.push(callback); },
    createElement(type, props, ...children) {
      return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
    },
  };
  return {
    React,
    effects,
    states,
    reset() { index = 0; effects.length = 0; },
  };
}

function mountPanel(context, factory, React) {
  let renderSection;
  const { apply } = factory((name) => name === 'react' ? React : undefined);
  apply({
    slots: {
      inject: (_name, callback) => { callback(); },
      register: (_options, render) => { renderSection = render; },
    },
    effect: () => {},
  });
  const panel = renderSection().props.children;
  return { Panel: panel.type, props: panel.props };
}

function textOf(node) {
  if (node === undefined || node === null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.props?.children);
}

function elementsOf(node, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, result);
    return result;
  }
  result.push(node);
  return elementsOf(node.props?.children, result);
}

test('update is independent of the main refresh and its failure preserves data', async () => {
  const { context, factory } = loadClient();
  const hooks = createHooks();
  const data = payload();
  const calls = [];
  context.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path === ROUTE) return { ok: true, json: async () => data };
    return { ok: false, status: 503, json: async () => ({ error: 'offline' }) };
  };
  const { Panel, props } = mountPanel(context, factory, hooks.React);
  const render = () => {
    hooks.reset();
    return Panel(props);
  };
  render();
  await hooks.effects[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  render();
  await hooks.effects[2]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.slice(0, 2).map((call) => call.path), [ROUTE, ROUTE + '/update']);
  assert.equal(calls[1].options.priority, 'low');
  assert.equal(hooks.states[0].phase, 'ready');
  assert.equal(hooks.states[0].data, data);
  assert.equal(hooks.states[0].error, '');
  assert.equal(hooks.states[4].phase, 'unavailable');
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, current: '0.1.6', latest: '0.1.6' }),
  });
  await hooks.effects[2]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hooks.states[4].info.current, '0.1.6');
  assert.equal(hooks.states[4].info.latest, '0.1.6');
  assert.match(textOf(render()), /Current 0\.1\.6 · latest 0\.1\.6/);
});

test('aggregate, conflicts, compositions, and available update details are visible', () => {
  const { context, factory } = loadClient();
  const hooks = createHooks();
  const { Panel, props } = mountPanel(context, factory, hooks.React);
  const render = () => {
    hooks.reset();
    return Panel(props);
  };
  render();
  hooks.states[0] = {
    phase: 'ready',
    data: payload({
      matrix: matrix({ plugins: 50 }),
      rows: [{
        name: 'demo', version: '1.0.0', health: { state: 'recorded-active' },
        cells: [{ dsh: '0.2.0-rc.2', composition: 'headless', status: 'awaiting-service' }, { dsh: '0.2.0-rc.2', composition: 'web', status: 'active' }],
      }],
      conflicts: {
        tools: [{ resource: 'shared', plugins: ['demo', 'other'], status: 'candidate' }],
        slots: [{ resource: 'sidebar', plugins: ['demo', 'other'], status: 'candidate' }],
        routes: [{ resource: 'GET /api/x', plugins: ['demo', 'other'], status: 'candidate' }],
        verified: { tools: [{ resource: 'shared', plugins: ['demo', 'other'], status: 'collision', trust: 'self-reported' }], slots: [], routes: [] },
      },
    }),
  };
  hooks.states[4] = { phase: 'ready', info: { current: '0.1.6', latest: '0.2.0' } };
  const text = textOf(render());
  assert.match(text, /Ecosystem snapshot/);
  assert.match(text, /50 plugins/);
  assert.match(text, /run-123/);
  assert.match(text, /headless/);
  assert.match(text, /web/);
  assert.match(text, /shared.*demo, other.*candidate.*collision/);
  assert.match(text, /sidebar.*runtime not verified/);
  assert.match(text, /GET \/api\/x/);
  assert.match(text, /0\.1\.6.*0\.2\.0/);
});

test('empty conflict results still have an explicit evidence section', () => {
  const { context, factory } = loadClient();
  const hooks = createHooks();
  const { Panel, props } = mountPanel(context, factory, hooks.React);
  const render = () => {
    hooks.reset();
    return Panel(props);
  };
  render();
  hooks.states[0] = { phase: 'ready', data: payload() };
  const text = textOf(render());
  assert.match(text, /Plugin conflicts/);
  assert.match(text, /Static candidates and runtime results are separate/);
});

test('browser actions include the server-required explicit action header', async () => {
  const { context, factory } = loadClient();
  const hooks = createHooks();
  const data = payload({ rows: [{ name: 'demo', version: '1.0.0', health: { state: 'recorded-failure' }, cells: [] }] });
  const calls = [];
  context.fetch = async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => path === ROUTE + '/action' ? { ok: true } : data };
  };
  const { Panel, props } = mountPanel(context, factory, hooks.React);
  const render = () => {
    hooks.reset();
    return Panel(props);
  };
  render();
  hooks.states[0] = { phase: 'ready', data };
  const remove = elementsOf(render()).find((element) => element.props?.['aria-label'] === 'Remove demo');
  remove.props.onClick({ currentTarget: { isConnected: true, focus: () => {} } });
  const confirm = elementsOf(render()).find((element) => element.type === 'button' && textOf(element) === 'Confirm remove');
  await confirm.props.onClick();
  const action = calls.find((call) => call.path === ROUTE + '/action');
  assert.equal(action.options.headers['x-dsh-plugin-lint-action'], '1');
  assert.deepEqual(JSON.parse(action.options.body), { action: 'isolate', plugin: 'demo', confirmed: true });
});
