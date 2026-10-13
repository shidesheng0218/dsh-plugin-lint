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
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
      surface: 'var(--dsw-alias-bg-layer-1, transparent)',
    };

    const STATUS = {
      active: { color: 'var(--dsw-alias-state-success-primary, #1a7f37)', label: 'active' },
      'awaiting-service': { color: 'var(--dsw-alias-state-warn-primary, #bf8700)', label: 'untested here' },
      'rejected-by-host': { color: 'var(--dsw-alias-state-error-primary, #cf222e)', label: 'refused by host' },
      'inactive-error': { color: 'var(--dsw-alias-state-error-primary, #cf222e)', label: 'failed to mount' },
      'boot-failed': { color: 'var(--dsw-alias-state-error-primary, #cf222e)', label: 'boot failed' },
      'install-failed': { color: 'var(--dsw-alias-state-warn-primary, #bf8700)', label: 'install failed' },
    };

    function pill(status, title) {
      const style = STATUS[status] || { color: T.tertiary, label: status || 'unknown' };
      return React.createElement('span', {
        title,
        style: {
          display: 'inline-block', padding: '1px 8px', borderRadius: '999px',
          border: '1px solid ' + style.color, color: style.color, fontSize: '12px', whiteSpace: 'nowrap',
        },
      }, style.label);
    }

    function cellFor(row, version) {
      return (row.cells || []).find((c) => c.dsh === version);
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

      if (state.phase === 'loading') return React.createElement('div', { style: { color: T.secondary, padding: '16px 0' } }, 'Reading the matrix…');
      if (state.phase === 'error') return React.createElement('div', { style: { color: T.text, padding: '16px 0' } }, 'Could not read the panel data: ' + state.error);

      const data = state.data || {};
      if (data.ok === false) return React.createElement('div', { style: { color: T.text, padding: '16px 0' } }, 'Panel error: ' + data.error);
      const versions = (data.matrix && data.matrix.dshVersions) || [];
      const s = summary(data);

      const header = React.createElement('tr', null,
        React.createElement('th', { style: th }, 'Plugin'),
        versions.map((v) => React.createElement('th', { key: v, style: th }, v)));

      const body = (data.rows || []).map((row) => React.createElement('tr', { key: row.name },
        React.createElement('td', { style: td },
          React.createElement('div', { style: { color: T.text } }, row.name),
          React.createElement('div', { style: { color: T.tertiary, fontSize: '12px' } },
            (row.version || 'not installed') + (row.known ? '' : ' · not in the matrix'))),
        versions.map((v) => {
          const cell = cellFor(row, v);
          if (!cell) return React.createElement('td', { key: v, style: td }, React.createElement('span', { style: { color: T.tertiary } }, '—'));
          const tools = (cell.toolsAdded || []).length;
          const title = [cell.status, cell.trust, cell.reproduce].filter(Boolean).join(' · ');
          return React.createElement('td', { key: v, style: td },
            pill(cell.status, title),
            tools ? React.createElement('div', { style: { color: T.secondary, fontSize: '12px', marginTop: '2px' } }, '+' + tools + ' tools') : null);
        })));

      return React.createElement('div', { style: { color: T.text, maxWidth: '880px' } },
        React.createElement('div', { style: { fontSize: '16px', fontWeight: 600 } }, LABEL),
        React.createElement('div', { style: { color: T.secondary, fontSize: '13px', margin: '4px 0 12px' } },
          'Running DSH ' + ((data.dsh && data.dsh.version) || 'unknown')
          + ' · matrix of ' + ((data.matrix && data.matrix.plugins) || 0) + ' plugins, generated ' + ((data.matrix && data.matrix.generatedAt) || 'unknown')),
        data.profile && data.profile.error
          ? React.createElement('div', { style: { color: T.secondary, fontSize: '13px', marginBottom: '8px' } }, data.profile.error)
          : null,
        React.createElement('div', { style: { color: T.secondary, fontSize: '13px', marginBottom: '8px' } },
          s.total + ' installed · ' + s.known + ' covered by the matrix · ' + s.atRisk + ' with a failure on some version'),
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          React.createElement('thead', null, header),
          React.createElement('tbody', null, body)),
        React.createElement('div', { style: { color: T.tertiary, fontSize: '12px', marginTop: '12px', lineHeight: 1.6 } },
          'Each cell is a probe result from a throwaway profile, host half only: a plugin whose browser half is loaded in the web app is not exercised by the probe. '
          + '"untested here" means the plugin was waiting for a service that composition does not provide — it is not a failure. '
          + 'Cells state detected facts about named packages; they are not a verdict.'));
    }

    const th = { textAlign: 'left', padding: '6px 10px', borderBottom: T.border, color: T.secondary, fontWeight: 500, fontSize: '12px' };
    const td = { padding: '8px 10px', borderBottom: T.border, verticalAlign: 'top' };

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: undefined }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (this.state.error) {
          return React.createElement('div', { style: { color: T.text, padding: '16px 0' } },
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
