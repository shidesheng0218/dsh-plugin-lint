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
  id: 'dsh-plugin-lint-panel',
  factory: (require) => {
    const React = require('react');

    const ROUTE = '/api/dsh-plugin-lint/panel';
    const LABEL = 'Plugin compatibility';

    const T = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      secondary: 'var(--dsw-alias-label-secondary, currentColor)',
      tertiary: 'var(--dsw-alias-label-tertiary, currentColor)',
      hairline: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
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

    function Panel() {
      const [state, setState] = React.useState({ phase: 'loading' });
      React.useEffect(() => {
        let alive = true;
        fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((response) => response.json())
          .then((data) => { if (alive) setState({ phase: 'ready', data }); })
          .catch((error) => { if (alive) setState({ phase: 'error', error: String((error && error.message) || error) }); });
        return () => { alive = false; };
      }, []);

      const quiet = { color: T.secondary, fontSize: '13px', padding: '16px 0' };
      if (state.phase === 'loading') return React.createElement('div', { style: quiet }, 'Reading the matrix…');
      if (state.phase === 'error') return React.createElement('div', { style: quiet }, 'Could not read the panel data: ' + state.error);

      const data = state.data || {};
      if (data.ok === false) return React.createElement('div', { style: quiet }, 'Panel error: ' + data.error);
      const versions = (data.matrix && data.matrix.dshVersions) || [];
      const s = summary(data);

      // Community plugins carry the matrix cells, so they come first; the bundles
      // the DSH installation provides are grouped under a subdued subhead instead
      // of filling the table with identical dashes.
      const all = data.rows || [];
      const community = all.filter((r) => !r.firstParty);
      const firstParty = all.filter((r) => r.firstParty);
      const ordered = [...community, ...firstParty];

      const header = React.createElement('tr', null,
        React.createElement('th', { style: { ...th, width: '100%' } }, 'Plugin'),
        versions.map((v) => React.createElement('th', { key: v, style: { ...th, fontFamily: T.mono, fontWeight: 500 } }, v)));

      const subhead = firstParty.length > 0 && community.length > 0
        ? React.createElement('tr', { key: '__firstparty' },
            React.createElement('td', {
              colSpan: versions.length + 1,
              style: { padding: '14px 2px 6px', color: T.tertiary, fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' },
            }, 'Bundled with DSH'))
        : null;

      const rowOf = (row) => React.createElement('tr', { key: row.name },
        React.createElement('td', { style: td },
          React.createElement('div', { style: { color: T.text, fontFamily: T.mono, fontSize: '12.5px', letterSpacing: '-0.01em' } }, row.name),
          React.createElement('div', { style: { color: T.tertiary, fontSize: '12px', marginTop: '1px' } },
            (row.version || (row.providedBy === 'dsh-installation' ? 'bundled with DSH' : 'not installed'))
            + (row.known || row.firstParty ? '' : ' · not in the matrix'))),
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
        }));

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
          React.createElement('div', { style: { fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em' } }, LABEL),
          React.createElement('div', { style: { color: T.tertiary, fontSize: '12px', fontFamily: T.mono } },
            'DSH ' + ((data.dsh && data.dsh.version) || 'unknown'))),
        React.createElement('div', { style: { color: T.secondary, fontSize: '13px', margin: '4px 0 16px' } },
          'Matrix of ' + ((data.matrix && data.matrix.plugins) || 0) + ' plugins, generated ' + formatDate(data.matrix && data.matrix.generatedAt)
          + ' · ' + s.total + ' installed, ' + s.known + ' covered, ' + s.atRisk + ' with a failure on some version'),
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
              'DSH ' + data.upgrade.latest + ' is available'),
            React.createElement('div', { style: { color: T.secondary } },
              data.upgrade.worse + ' of your installed plugin' + (data.upgrade.worse === 1 ? '' : 's')
              + ' would get a worse verdict on ' + data.upgrade.latest + '. You are running ' + data.upgrade.running + '.'))
          : null,
        data.profile && data.profile.error
          ? React.createElement('div', { style: { ...quiet, padding: '0 0 8px' } }, data.profile.error)
          : null,
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          React.createElement('thead', null, header),
          React.createElement('tbody', null, bodyRows)),
        ecosystem && ecoVersions.length > 0 ? React.createElement('div', { style: { marginTop: '28px' } },
          React.createElement('div', { style: { color: T.tertiary, fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' } },
            'The matrix so far'),
          React.createElement('div', { style: { color: T.secondary, fontSize: '13px', marginBottom: '12px' } },
            (data.matrix.plugins || 0) + ' plugins probed across ' + ecoVersions.length + ' DSH versions'),
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
                  active + ' active · ' + rejected + ' refused · ' + waiting + ' awaiting · ' + pct + '% mounted')),
              React.createElement('div', { style: { height: '3px', borderRadius: '999px', background: T.surface, overflow: 'hidden', display: 'flex' } },
                React.createElement('div', { style: { width: (total > 0 ? (active / total) * 100 : 0) + '%', background: STATUS.active.color } }),
                React.createElement('div', { style: { width: (total > 0 ? (waiting / total) * 100 : 0) + '%', background: STATUS['awaiting-service'].color } }),
                React.createElement('div', { style: { width: (total > 0 ? (rejected / total) * 100 : 0) + '%', background: STATUS['rejected-by-host'].color } })));
          })) : null,
        React.createElement('div', {
          style: { color: T.tertiary, fontSize: '12px', marginTop: '16px', paddingTop: '12px', borderTop: T.hairline, lineHeight: 1.6 },
        },
          'Each cell is a probe result from a throwaway profile, host half only: a plugin whose browser half is loaded in the web app is not exercised by the probe. '
          + '"untested here" means the plugin was waiting for a service that composition does not provide — it is not a failure. '
          + 'Cells state detected facts about named packages; they are not a verdict.'));
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
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'plugin-lint',
        order: 80,
        label: () => LABEL,
      }, () => React.createElement(Boundary, null, React.createElement(Panel))));
    }

    return { apply, inject: ['slots'] };
  },
});
