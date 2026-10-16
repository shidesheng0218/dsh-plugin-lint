/**
 * Browser half: one settings section listing the installed plugins against the
 * compatibility matrix.
 *
 * Only react comes from the browser module table. The reference advises against
 * loading Harness Client packages as modules, so no styling primitive is
 * imported; colours come from the --dsw-alias-* tokens the host already defines,
 * each with a fallback so a renamed token degrades instead of breaking.
 *
 * The component is wrapped in an error boundary: a throwing component blanks its
 * whole slot entry, and a blank settings page is a worse failure than an error
 * message.
 *
 * Visual grammar: the host settings page is a quiet white surface, so the panel
 * is built from type weight and grey steps, not chrome — a filled pill for a
 * verdict (the same weight the host gives its own state labels), a thin dot for
 * "not covered", and one hairline under the header instead of a boxed grid.
 */
window.__ModuleLoader__.load({
  id: '@shidesheng0218/dsh-plugin-lint-panel',
  factory: (require) => {
    const React = require('react');

    const ROUTE = '/api/dsh-plugin-lint/panel';
    const NS = 'dsh-plugin-lint-panel';
    const LABEL = 'Plugin compatibility';

    const T = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      secondary: 'var(--dsw-alias-label-secondary, currentColor)',
      tertiary: 'var(--dsw-alias-label-tertiary, currentColor)',
      hairline: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    // Visible UI text goes through the Client locale service: the host's
    // language setting decides which dictionary each string comes from.
    const DICT = {
      en: {
        title: 'Plugin compatibility',
        loading: 'Reading the matrix…',
        error: 'Could not read the panel data: ',
        panelError: 'Panel error: ',
        matrixOf: 'Matrix of {plugins} plugins, generated {date}',
        installed: '{total} installed, {known} covered, {atRisk} with a failure on some version',
        noPerPlugin: ' · run the matrix to see your own plugins here',
        upgradeTitle: 'DSH {version} is available',
        upgradeBody: '{count} of your installed plugins would get a worse verdict on {version}. You are running {running}.',
        theMatrixSoFar: 'The matrix so far',
        probedAcross: '{plugins} plugins probed across {versions} DSH versions',
        active: 'active',
        refused: 'refused',
        awaiting: 'awaiting',
        mounted: 'mounted',
        footer: 'Each cell is a probe result from a throwaway profile, host half only: a plugin whose browser half is loaded in the web app is not exercised by the probe. "untested here" means the plugin was waiting for a service that composition does not provide — it is not a failure. Cells state detected facts about named packages; they are not a verdict.',
        capabilities: 'Capabilities',
        capNetwork: 'network',
        capShell: 'shell',
        capFsRead: 'fs-read',
        capFsWrite: 'fs-write',
        capEnv: 'env',
        capUiInjection: 'ui-injection',
        capLlm: 'llm',
        capSessionWrite: 'session-write',
        capConnection: 'connection',
        capTelemetry: 'telemetry',
        fix: 'Fix',
        fixing: 'Fixing…',
        fixed: 'Fixed',
        isolate: 'Disable',
        isolating: 'Disabling…',
        isolated: 'Disabled',
        conflictTitle: 'Slot conflicts',
        conflictBody: '{count} slot names are claimed by more than one plugin. Two plugins claiming the same slot cannot both mount — the later one is discarded.',
      },
      zh: {
        title: '插件兼容性',
        loading: '正在读取矩阵…',
        error: '无法读取面板数据：',
        panelError: '面板错误：',
        matrixOf: '矩阵覆盖 {plugins} 个插件，生成于 {date}',
        installed: '已安装 {total} 个，覆盖 {known} 个，{atRisk} 个在某版本上失败',
        noPerPlugin: ' · 运行矩阵以查看你自己的插件',
        upgradeTitle: 'DSH {version} 已发布',
        upgradeBody: '你安装的 {count} 个插件在 {version} 上会变得更差。你正在运行 {running}。',
        theMatrixSoFar: '矩阵全景',
        probedAcross: '已探测 {plugins} 个插件 × {versions} 个 DSH 版本',
        active: '正常',
        refused: '被拒绝',
        awaiting: '等待服务',
        mounted: '已挂载',
        footer: '每格是一次性 profile 的探针结果，仅 host 半边：浏览器半边由 web 应用加载，不在探针范围内。"等待服务"表示插件在等待该组合未提供的服务——不是失败。格子陈述的是对具名包的检测事实，不是裁决。',
        capabilities: '能力',
        capNetwork: '网络',
        capShell: '命令执行',
        capFsRead: '读文件',
        capFsWrite: '写文件',
        capEnv: '环境变量',
        capUiInjection: 'UI 注入',
        capLlm: '模型调用',
        capSessionWrite: '会话写入',
        capConnection: '连接服务',
        capTelemetry: '遥测',
        fix: '修复',
        fixing: '修复中…',
        fixed: '已修复',
        isolate: '禁用',
        isolating: '禁用中…',
        isolated: '已禁用',
        conflictTitle: 'Slot 冲突',
        conflictBody: '{count} 个 slot 名被多个插件认领。两个插件抢同一个 slot 时，后挂载的那个会被丢弃。',
      },
    };

    const STATUS = {
      active: { color: 'var(--dsw-alias-state-success-primary, #1a7f37)', label: 'active' },
      'awaiting-service': { color: 'var(--dsw-alias-state-warn-primary, #a35c00)', label: 'untested here' },
      'rejected-by-host': { color: 'var(--dsw-alias-state-error-primary, #cf222e)', label: 'refused by host' },
      'inactive-error': { color: 'var(--dsw-alias-state-error-primary, #cf222e)', label: 'failed to mount' },
      'boot-failed': { color: 'var(--dsw-alias-state-error-primary, #cf222e)', label: 'boot failed' },
      'install-failed': { color: 'var(--dsw-alias-state-warn-primary, #a35c00)', label: 'install failed' },
    };

    /** 2026-10-13T06:17:38.145Z -> Oct 13, 2026 — a date is read, a timestamp is not. */
    function formatDate(iso) {
      const time = Date.parse(iso || '');
      if (!Number.isFinite(time)) return iso || 'unknown';
      return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function pill(status, title) {
      const style = STATUS[status] || { color: T.tertiary, label: status || 'unknown' };
      return React.createElement('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 9px',
          borderRadius: '999px', background: style.color, color: '#fff',
          fontSize: '11px', fontWeight: 500, letterSpacing: '0.02em', whiteSpace: 'nowrap',
        },
      }, style.label);
    }

    /** A thin marker for "no cell" — quieter than a dash glyph at text size. */
    function none() {
      return React.createElement('span', {
        title: 'not covered by the matrix',
        style: { display: 'inline-block', width: '4px', height: '4px', borderRadius: '999px', background: T.tertiary, opacity: 0.55 },
      });
    }

    /** All cells for one DSH version — a plugin may have one per composition. */
    function cellsFor(row, version) {
      return (row.cells || []).filter((c) => c.dsh === version);
    }

    /**
     * The cell to show: the most favourable verdict, matching the site generator.
     * "awaiting webServer" in headless and "active" in web are both true, and only
     * together do they mean anything.
     */
    const RANK = { active: 0, 'awaiting-service': 1, 'rejected-by-host': 2, 'inactive-error': 3, 'boot-failed': 4, 'install-failed': 5 };
    function bestCell(cells) {
      return cells.slice().sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))[0];
    }

    function summary(data) {
      const rows = data.rows || [];
      const known = rows.filter((r) => r.known && !r.firstParty);
      const atRisk = known.filter((r) => (r.cells || []).some((c) => c.status === 'rejected-by-host' || c.status === 'inactive-error'));
      return { total: rows.length, known: known.length, atRisk: atRisk.length };
    }

    function Panel({ t }) {
      const [state, setState] = React.useState({ phase: 'loading' });
      React.useEffect(() => {
        let alive = true;
        fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((response) => response.json())
          .then((data) => { if (alive) setState({ phase: 'ready', data }); })
          .catch((error) => { if (alive) setState({ phase: 'error', error: String((error && error.message) || error) }); });
        return () => { alive = false; };
      }, []);

      // Hooks come before the early returns: React error #310 is what a hook
      // after a conditional return costs.
      const [actionState, setActionState] = React.useState({});

      const quiet = { color: T.secondary, fontSize: '13px', padding: '16px 0' };
      if (state.phase === 'loading') return React.createElement('div', { style: quiet }, t('loading'));
      if (state.phase === 'error') return React.createElement('div', { style: quiet }, t('error') + state.error);

      const data = state.data || {};
      if (data.ok === false) return React.createElement('div', { style: quiet }, t('panelError') + data.error);
      const versions = (data.matrix && data.matrix.dshVersions) || [];
      const s = summary(data);

      const runAction = (action, plugin) => {
        setActionState((prev) => ({ ...prev, [plugin]: action + 'ing' }));
        fetch(ROUTE + '/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, plugin }),
        })
          .then((r) => r.json())
          .then((result) => {
            setActionState((prev) => ({ ...prev, [plugin]: result.ok ? action + 'ed' : 'error' }));
            if (result.ok) setTimeout(() => window.location.reload(), 1500);
          })
          .catch(() => setActionState((prev) => ({ ...prev, [plugin]: 'error' })));
      };

      const actionButton = (action, plugin, label) => {
        const state = actionState[plugin];
        const busy = state === action + 'ing';
        const done = state === action + 'ed';
        return React.createElement('button', {
          onClick: () => runAction(action, plugin),
          disabled: busy || done,
          style: {
            padding: '3px 10px', borderRadius: '4px', border: '1px solid ' + T.tertiary,
            background: done ? STATUS.active.color : 'transparent',
            color: done ? '#fff' : T.text,
            fontSize: '11px', cursor: busy || done ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          },
        }, busy ? t(action + 'ing') : done ? t(action + 'ed') : label);
      };

      // Community plugins carry the matrix cells, so they come first; the bundles
      // the DSH installation provides are grouped under a subdued subhead instead
      // of filling the table with identical dashes.
      const all = data.rows || [];
      const community = all.filter((r) => !r.firstParty);
      const firstParty = all.filter((r) => r.firstParty);
      const ordered = [...community, ...firstParty];

      const header = React.createElement('tr', null,
        React.createElement('th', { style: { ...th, width: '100%' } }, 'Plugin'),
        React.createElement('th', { style: th }, t('capabilities')),
        versions.map((v) => React.createElement('th', { key: v, style: { ...th, fontFamily: T.mono, fontWeight: 500 } }, v)),
        React.createElement('th', { style: th }, ''));

      const subhead = firstParty.length > 0 && community.length > 0
        ? React.createElement('tr', { key: '__firstparty' },
            React.createElement('td', {
              colSpan: versions.length + 3,
              style: { padding: '14px 2px 6px', color: T.tertiary, fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' },
            }, 'Bundled with DSH'))
        : null;

      const CAPABILITY_LABEL = {
        network: t('capNetwork'),
        shell: t('capShell'),
        'fs-read': t('capFsRead'),
        'fs-write': t('capFsWrite'),
        env: t('capEnv'),
        'ui-injection': t('capUiInjection'),
        llm: t('capLlm'),
        'session-write': t('capSessionWrite'),
        connection: t('capConnection'),
        telemetry: t('capTelemetry'),
      };

      const rowOf = (row) => React.createElement('tr', { key: row.name },
        React.createElement('td', { style: td },
          React.createElement('div', { style: { color: T.text, fontFamily: T.mono, fontSize: '12.5px', letterSpacing: '-0.01em' } }, row.name),
          React.createElement('div', { style: { color: T.tertiary, fontSize: '12px', marginTop: '1px' } },
            (row.version || (row.providedBy === 'dsh-installation' ? 'bundled with DSH' : 'not installed'))
            + (row.known || row.firstParty ? '' : ' · not in the matrix'))),
        // The capability column: what the audit observed, as compact tags.
        React.createElement('td', { style: { ...td, maxWidth: '180px' } },
          row.audit && row.audit.observed && row.audit.observed.length > 0
            ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px' } },
                row.audit.observed.slice(0, 4).map((o) => React.createElement('span', {
                  key: o.capability,
                  title: o.sites + ' site' + (o.sites === 1 ? '' : 's') + ', first: ' + o.first.file,
                  style: {
                    display: 'inline-block', padding: '0 5px', borderRadius: '3px',
                    background: T.surface, color: T.secondary, fontSize: '10px', lineHeight: '16px',
                    fontFamily: T.mono, whiteSpace: 'nowrap',
                  },
                }, CAPABILITY_LABEL[o.capability] || o.capability)),
                row.audit.observed.length > 4
                  ? React.createElement('span', { style: { color: T.tertiary, fontSize: '10px' } }, '+' + (row.audit.observed.length - 4))
                  : null)
            : React.createElement('span', { style: { color: T.tertiary, fontSize: '12px' } }, '—')),
        versions.map((v) => {
          const cells = cellsFor(row, v);
          if (cells.length === 0) return React.createElement('td', { key: v, style: { ...td, textAlign: 'left' } }, none());
          // The tool count lives in the headless cell; the web cell exercises the
          // composition but never sends a model request. Read it from whichever
          // composition recorded one.
          const tools = Math.max(0, ...cells.map((c) => (c.toolsAdded || []).length));
          const cell = bestCell(cells);
          const title = [cell.status, cell.trust, cell.reproduce].filter(Boolean).join(' · ');
          return React.createElement('td', { key: v, style: td },
            pill(cell.status, title),
            tools ? React.createElement('div', { style: { color: T.tertiary, fontSize: '11px', marginTop: '3px', fontFamily: T.mono } }, '+' + tools + ' tools') : null);
        }),
        // The action column: fix a refused plugin, or disable one that conflicts.
        React.createElement('td', { style: { ...td, whiteSpace: 'nowrap' } },
          row.cells && row.cells.some((c) => c.status === 'rejected-by-host')
            ? actionButton('fix', row.name, t('fix'))
            : null));

      const bodyRows = [];
      let subheadPlaced = false;
      for (const row of ordered) {
        if (subhead && !subheadPlaced && row.firstParty) {
          bodyRows.push(subhead);
          subheadPlaced = true;
        }
        bodyRows.push(rowOf(row));
      }

      // The ecosystem block uses only aggregate counts the host computed from the
      // full matrix — never a package name — so it is safe to show even when the
      // snapshot names packages elsewhere.
      const ecosystem = (data.matrix && data.matrix.ecosystem) || null;
      const ecoVersions = ecosystem ? Object.keys(ecosystem.versions || {}) : [];

      return React.createElement('div', { style: { color: T.text, maxWidth: '880px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          React.createElement('div', { style: { fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em' } }, t('title')),
          React.createElement('div', { style: { color: T.tertiary, fontSize: '12px', fontFamily: T.mono } },
            'DSH ' + ((data.dsh && data.dsh.version) || 'unknown'))),
        React.createElement('div', { style: { color: T.secondary, fontSize: '13px', margin: '4px 0 16px' } },
          t('matrixOf', { plugins: (data.matrix && data.matrix.plugins) || 0, date: formatDate(data.matrix && data.matrix.generatedAt) })
          + ' · ' + t('installed', { total: s.total, known: s.known, atRisk: s.atRisk })
          + (data.matrix && data.matrix.hasPerPluginData === false ? t('noPerPlugin') : '')),
        // The upgrade banner: the running version is behind the matrix's newest,
        // and at least one installed plugin would get a worse verdict there.
        // It sits above the table because it is the one thing that changes what
        // the user should do next.
        data.upgrade && data.upgrade.worse > 0
          ? React.createElement('div', {
              style: {
                padding: '10px 14px', marginBottom: '16px', borderRadius: '6px',
                border: '1px solid var(--dsw-alias-state-warn-primary, #bf8700)',
                background: 'var(--dsw-alias-bg-layer-1, rgba(191,135,0,.06))',
                fontSize: '13px', lineHeight: 1.5,
              },
            },
            React.createElement('div', { style: { fontWeight: 600, color: T.text, marginBottom: '2px' } },
              t('upgradeTitle', { version: data.upgrade.latest })),
            React.createElement('div', { style: { color: T.secondary } },
              t('upgradeBody', { count: data.upgrade.worse, version: data.upgrade.latest, running: data.upgrade.running })))
          : null,
        data.profile && data.profile.error
          ? React.createElement('div', { style: { ...quiet, padding: '0 0 8px' } }, data.profile.error)
          : null,
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          React.createElement('thead', null, header),
          React.createElement('tbody', null, bodyRows)),
        ecosystem && ecoVersions.length > 0 ? React.createElement('div', { style: { marginTop: '28px' } },
          React.createElement('div', { style: { color: T.tertiary, fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' } },
            t('theMatrixSoFar')),
          React.createElement('div', { style: { color: T.secondary, fontSize: '13px', marginBottom: '12px' } },
            t('probedAcross', { plugins: (data.matrix.plugins || 0), versions: ecoVersions.length })),
          ecoVersions.map((v) => {
            const tally = ecosystem.versions[v] || {};
            const total = Object.values(tally).reduce((a, b) => a + b, 0);
            const active = tally['active'] || 0;
            const rejected = tally['rejected-by-host'] || 0;
            const waiting = tally['awaiting-service'] || 0;
            const pct = total > 0 ? Math.round((active / total) * 100) : 0;
            return React.createElement('div', { key: v, style: { marginBottom: '10px' } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' } },
                React.createElement('span', { style: { fontFamily: T.mono, fontSize: '12px', color: T.text } }, v),
                React.createElement('span', { style: { color: T.tertiary, fontSize: '12px' } },
                  active + ' ' + t('active') + ' · ' + rejected + ' ' + t('refused') + ' · ' + waiting + ' ' + t('awaiting') + ' · ' + pct + '% ' + t('mounted'))),
              React.createElement('div', { style: { height: '3px', borderRadius: '999px', background: T.surface, overflow: 'hidden', display: 'flex' } },
                React.createElement('div', { style: { width: (total > 0 ? (active / total) * 100 : 0) + '%', background: STATUS.active.color } }),
                React.createElement('div', { style: { width: (total > 0 ? (waiting / total) * 100 : 0) + '%', background: STATUS['awaiting-service'].color } }),
                React.createElement('div', { style: { width: (total > 0 ? (rejected / total) * 100 : 0) + '%', background: STATUS['rejected-by-host'].color } })));
          })) : null,
        // Slot conflicts: two plugins claiming the same slot cannot both mount.
        // The panel names them and offers to disable one.
        data.conflicts && data.conflicts.length > 0
          ? React.createElement('div', { style: { marginTop: '24px', padding: '14px', borderRadius: '6px', border: '1px solid ' + T.hairline, background: T.surface } },
              React.createElement('div', { style: { fontWeight: 600, fontSize: '13px', color: T.text, marginBottom: '6px' } }, t('conflictTitle')),
              React.createElement('div', { style: { color: T.secondary, fontSize: '13px', marginBottom: '10px' } }, t('conflictBody', { count: data.conflicts.length })),
              data.conflicts.map((c) => React.createElement('div', { key: c.slot, style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontFamily: T.mono, fontSize: '12px', color: T.text } }, c.slot),
                c.plugins.map((p, i) => React.createElement(React.Fragment, { key: p },
                  i > 0 ? React.createElement('span', { style: { color: T.tertiary, fontSize: '12px' } }, ' vs ') : null,
                  React.createElement('span', { style: { fontFamily: T.mono, fontSize: '12px', color: T.text } }, p),
                  actionButton('isolate', p, t('isolate')))))))
          : null,
        React.createElement('div', {
          style: { color: T.tertiary, fontSize: '12px', marginTop: '16px', paddingTop: '12px', borderTop: T.hairline, lineHeight: 1.6 },
        }, t('footer')));
    }

    const th = {
      textAlign: 'left', padding: '0 12px 8px 2px', borderBottom: T.hairline,
      color: T.tertiary, fontWeight: 500, fontSize: '11px', letterSpacing: '0.04em', whiteSpace: 'nowrap',
    };
    const td = { padding: '10px 12px 10px 2px', borderBottom: T.hairline, verticalAlign: 'top' };

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: undefined }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (this.state.error) {
          return React.createElement('div', { style: { color: T.text, fontSize: '13px', padding: '16px 0' } },
            'The compatibility panel failed to render: ' + String(this.state.error && this.state.error.message || this.state.error));
        }
        return this.props.children;
      }
    }

    function apply(ctx) {
      // The locale service is optional: a profile without it still mounts, and
      // the panel falls back to English.
      const t = ctx.locale ? ctx.locale.bind(NS) : (key, vars) => {
        const template = DICT.en[key] || key;
        return template.replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''));
      };
      if (ctx.locale) {
        ctx.effect(() => ctx.locale.register(NS, DICT), NS + ': dictionaries');
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'plugin-lint',
        order: 80,
        label: () => t('title'),
      }, () => React.createElement(Boundary, null, React.createElement(Panel, { t }))));
    }

    return { apply, inject: ['slots', 'locale'] };
  },
});
