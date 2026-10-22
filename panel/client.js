window.__ModuleLoader__.load({
  id: '@shidesheng0218/dsh-plugin-lint-panel',
  factory: (require) => {
    const React = require('react');
    const ROUTE = '/api/dsh-plugin-lint/panel';
    const NS = 'dsh-plugin-lint-panel';
    const T = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      secondary: 'var(--dsw-alias-label-secondary, currentColor)',
      tertiary: 'var(--dsw-alias-label-tertiary, currentColor)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #a35c00)',
      error: 'var(--dsw-alias-state-error-primary, #cf222e)',
    };
    const DICT = {
      en: {
        title: 'Plugin Health Center',
        description: 'See what is healthy, what needs attention, and what has not been verified yet.',
        loading: 'Checking plugin health…',
        error: 'Could not read plugin health: ',
        panelError: 'The panel returned an error: ',
        unknownError: 'Something went wrong.',
        healthy: 'Healthy',
        attention: 'Needs attention',
        unverified: 'Unverified',
        checked: 'Last checked {date}',
        issues: 'Needs attention',
        noIssues: 'No recorded failures found. Unverified plugins still need checking.',
        refresh: 'Refresh',
        summary: '{healthy} healthy, {attention} need attention, {unverified} unverified',
        recordedActive: 'Historical check passed',
        mixed: 'Recorded results differ between test setups; check the compatibility details.',
        evidence: 'Recorded for DSH {dsh}, plugin {version}: {status}',
        installed: 'Installed; unverified',
        confirmReinstall: 'Reinstall this plugin?',
        confirmReinstallBody: 'This runs the plugin installer again in this profile. It may change installed files and does not guarantee that the issue will be resolved.',
        confirmFix: 'Confirm reinstall',
        preview: 'Version comparison',
        previewBody: '{count} plugins have a worse recorded result on DSH {version} than on {running}. This is matrix evidence, not an update notice.',
        probeActive: 'Probe passed',
        probeWaiting: 'Waiting for service',
        probeFailure: 'Probe failed',
        issueReason: 'Why this needs attention',
        plugins: 'Your plugins',
        plugin: 'Plugin',
        status: 'Status',
        action: 'Action',
        reinstall: 'Reinstall',
        reinstalling: 'Reinstalling…',
        reinstalled: 'Reinstalled',
        remove: 'Remove',
        removing: 'Removing…',
        removed: 'Removed',
        confirmRemove: 'Remove this plugin?',
        confirmRemoveBody: 'This removes the plugin from your profile. You can add it again later.',
        confirm: 'Confirm remove',
        cancel: 'Cancel',
        actionError: 'Action could not be completed: ',
        notInstalled: 'Not installed',
        bundled: 'Provided by DSH',
        unknown: 'Unknown',
        unverifiedReason: 'This plugin has not been verified for the current setup.',
        matrix: 'Compatibility details',
        version: 'Version',
        capabilities: 'Capabilities',
        conflicts: 'Possible slot overlap',
        conflictBody: 'These plugins use the same slot name; check their setup before removing anything.',
        noData: 'No plugin data is available yet.',
        current: 'Current',
        covered: 'Covered',
        historical: 'Historical result; runtime is not verified.',
        recordedFailure: 'The compatibility check recorded a failure.',
        waiting: 'The check is waiting for a service.',
        stale: 'The compatibility result is out of date.',
        missingInstall: 'The plugin is not installed in this profile.',
        state: 'Health state: {state}.',
        details: 'Details',
        tools: '{count} tools',
        noCapabilities: 'No capabilities recorded',
        matrixUnavailable: 'Not covered by the matrix',
        yes: 'Yes',
        no: 'No'
      },
      zh: {
        title: '插件健康中心',
        description: '查看哪些插件正常、哪些需要处理，以及哪些尚未验证。',
        loading: '正在检查插件健康状态…',
        error: '无法读取插件健康状态：',
        panelError: '面板返回错误：',
        unknownError: '发生了未知错误。',
        healthy: '状态良好',
        attention: '需要处理',
        unverified: '尚未验证',
        checked: '上次检查：{date}',
        issues: '需要处理',
        noIssues: '未发现已记录的失败；尚未验证的插件仍需检查。',
        refresh: '刷新',
        summary: '{healthy} 个状态良好，{attention} 个需要处理，{unverified} 个尚未验证',
        recordedActive: '历史检查通过',
        mixed: '不同测试设置下的历史结果不一致，请查看兼容性详情。',
        evidence: '历史记录：DSH {dsh}，插件 {version}：{status}',
        installed: '已安装，尚未验证',
        confirmReinstall: '重新安装这个插件？',
        confirmReinstallBody: '这会在当前 profile 中再次运行插件安装器，可能更改安装文件，并不保证解决问题。',
        confirmFix: '确认重新安装',
        preview: '版本比较',
        previewBody: '相较于 {running}，{count} 个插件在 DSH {version} 的历史检查中结果更差。这是矩阵证据，不是更新通知。',
        probeActive: '探针通过',
        probeWaiting: '等待服务',
        probeFailure: '探针失败',
        issueReason: '需要处理的原因',
        plugins: '你的插件',
        plugin: '插件',
        status: '状态',
        action: '操作',
        reinstall: '重新安装',
        reinstalling: '重新安装中…',
        reinstalled: '已重新安装',
        remove: '移除',
        removing: '移除中…',
        removed: '已移除',
        confirmRemove: '移除这个插件？',
        confirmRemoveBody: '这会将插件从当前 profile 中移除，之后仍可重新添加。',
        confirm: '确认移除',
        cancel: '取消',
        actionError: '操作未完成：',
        notInstalled: '未安装',
        bundled: '由 DSH 提供',
        unknown: '未知',
        unverifiedReason: '当前设置尚未验证此插件。',
        matrix: '兼容性详情',
        version: '版本',
        capabilities: '能力',
        conflicts: '可能存在 Slot 重叠',
        conflictBody: '这些插件使用了相同的 slot 名称；移除前请先确认配置。',
        noData: '暂时没有插件数据。',
        current: '当前',
        covered: '已覆盖',
        historical: '历史结果；运行时尚未验证。',
        recordedFailure: '兼容性检查记录到了失败。',
        waiting: '检查正在等待服务。',
        stale: '兼容性结果已过期。',
        missingInstall: '插件未安装在此 profile 中。',
        state: '健康状态：{state}。',
        details: '详情',
        tools: '{count} 个工具',
        noCapabilities: '未记录能力',
        matrixUnavailable: '矩阵未覆盖',
        yes: '是',
        no: '否'
      }
    };

    // A historical probe cannot establish the health of this running profile.
    function healthBucket(row) {
      const state = row.health && row.health.state;
      if (state === 'healthy' || state === 'verified-active') return 'healthy';
      if (state === 'recorded-failure' || state === 'missing-install') return 'attention';
      return 'unverified';
    }

    function healthReason(row, t) {
      const state = row.health && row.health.state;
      const keys = {
        'recorded-active': 'historical',
        'recorded-failure': 'recordedFailure',
        'missing-install': 'missingInstall',
        waiting: 'waiting', stale: 'stale', installed: 'bundled', mixed: 'mixed',
      };
      if (keys[state]) return t(keys[state]);
      const evidence = row.health && row.health.evidence;
      if (evidence) return t('evidence', {
        dsh: evidence.dsh || '?', version: evidence.pluginVersion || '?',
        status: evidence.status || '?',
      });
      return row.health && row.health.reason || t('unverifiedReason');
    }

    function errorMessage(error, fallback) {
      if (typeof error === 'string') return error;
      if (error && typeof error.message === 'string') return error.message;
      if (error && error.error) return errorMessage(error.error, fallback);
      return fallback;
    }

    async function request(path, body) {
      const response = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error('HTTP ' + response.status); }
      if (!response.ok || data.ok === false) {
        throw new Error(errorMessage(data.error || data, 'HTTP ' + response.status));
      }
      return data;
    }

    function formatDate(value) {
      const time = Date.parse(value || '');
      return Number.isFinite(time) ? new Date(time).toLocaleString() : '';
    }

    const buttonStyle = {
      padding: '6px 11px', borderRadius: '4px', border: T.border,
      background: 'transparent', color: T.text, cursor: 'pointer', fontSize: '12px',
    };
    const quiet = { color: T.secondary, fontSize: '13px', lineHeight: 1.6 };
    const heading = { fontSize: '15px', fontWeight: 600, margin: '0 0 10px' };
    const tableCell = {
      textAlign: 'left', padding: '9px 12px 9px 0', borderBottom: T.border,
      fontSize: '12px', verticalAlign: 'top',
    };

    function Panel({ t }) {
      const [state, setState] = React.useState({ phase: 'loading' });
      const [actions, setActions] = React.useState({});
      const [confirmation, setConfirmation] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const mounted = React.useRef(false);
      const confirmationRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const busyRef = React.useRef(false);

      const refresh = async () => {
        setState((previous) => ({ ...previous, refreshing: true, error: '' }));
        try {
          const data = await request(ROUTE);
          if (mounted.current) setState({ phase: 'ready', data });
        } catch (error) {
          if (mounted.current) setState((previous) => ({
            ...previous, phase: previous.data ? 'ready' : 'error', refreshing: false,
            error: errorMessage(error, t('unknownError')),
          }));
        }
      };
      React.useEffect(() => {
        mounted.current = true;
        refresh();
        return () => { mounted.current = false; };
      }, []);
      React.useEffect(() => {
        if (confirmation && confirmationRef.current) confirmationRef.current.focus();
      }, [confirmation]);

      const dismissConfirmation = () => {
        setConfirmation(null);
        if (triggerRef.current && triggerRef.current.isConnected) triggerRef.current.focus();
      };
      const runAction = async () => {
        if (!confirmation || busyRef.current) return;
        const { action, plugin } = confirmation;
        busyRef.current = true;
        setActions((previous) => ({ ...previous, [plugin]: { phase: 'working', action } }));
        setConfirmation(null);
        try {
          await request(ROUTE + '/action', { action, plugin, confirmed: true });
          if (!mounted.current) return;
          setNotice(t(action === 'fix' ? 'reinstalled' : 'removed') + ': ' + plugin);
          setActions((previous) => ({ ...previous, [plugin]: {} }));
          await refresh();
        } catch (error) {
          if (mounted.current) setActions((previous) => ({
            ...previous, [plugin]: { phase: 'error', error: errorMessage(error, t('unknownError')) },
          }));
        } finally {
          busyRef.current = false;
          if (triggerRef.current && triggerRef.current.isConnected) triggerRef.current.focus();
        }
      };

      const data = state.data || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const counts = rows.reduce((result, row) => {
        result[healthBucket(row)] += 1;
        return result;
      }, { healthy: 0, attention: 0, unverified: 0 });
      // Summary is supplemental: row evidence controls each visible classification.
      const total = data.summary && Number.isFinite(data.summary.total)
        ? data.summary.total : rows.length;
      const issues = rows.filter((row) => healthBucket(row) === 'attention');
      const versions = data.matrix && data.matrix.dshVersions || [];
      const isProtected = (row) => row.firstParty || row.name.startsWith('@deepseek-ai/')
        || row.name === '@shidesheng0218/dsh-plugin-lint-panel';
      const anyBusy = Object.values(actions).some((action) => action.phase === 'working');
      const actionButtons = (row) => {
        if (isProtected(row)) return null;
        const actionState = actions[row.name] || {};
        const canReinstall = row.version && healthBucket(row) === 'attention';
        return React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap' } },
            (canReinstall ? ['fix', 'isolate'] : ['isolate']).map((action) =>
              React.createElement('button', {
                key: action, type: 'button', disabled: anyBusy || state.refreshing,
                style: buttonStyle,
                'aria-label': t(action === 'fix' ? 'reinstall' : 'remove') + ' ' + row.name,
                onClick: (event) => {
                  triggerRef.current = event.currentTarget;
                  setConfirmation({ action, plugin: row.name });
                },
              }, actionState.phase === 'working'
                ? t(actionState.action === 'fix' ? 'reinstalling' : 'removing')
                : t(action === 'fix' ? 'reinstall' : 'remove')))),
          actionState.error ? React.createElement('p', {
            role: 'alert', style: { ...quiet, color: T.error, margin: '7px 0 0' },
          }, t('actionError') + actionState.error) : null);
      };
      const statusText = (row) => {
        const state = row.health && row.health.state;
        if (state === 'recorded-active') return t('recordedActive');
        if (state === 'installed') return t('installed');
        return t(healthBucket(row));
      };
      const colorFor = (row) => healthBucket(row) === 'attention' ? T.error
        : healthBucket(row) === 'healthy' ? T.success : T.secondary;

      return React.createElement('div', {
        style: { color: T.text, maxWidth: '880px', width: '100%', lineHeight: 1.5 },
      },
      React.createElement('header', null,
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
        },
          React.createElement('h2', { style: { fontSize: '22px', margin: 0, fontWeight: 600 } }, t('title')),
          React.createElement('button', {
            type: 'button', style: buttonStyle, disabled: state.refreshing || anyBusy,
            onClick: refresh,
          }, t('refresh'))),
        React.createElement('p', { style: { ...quiet, maxWidth: '620px' } }, t('description')),
        React.createElement('p', { style: { ...quiet, margin: '0 0 5px' } },
          state.phase === 'loading' ? t('loading') : t('summary', counts)),
        data.checkedAt ? React.createElement('p', {
          style: { ...quiet, fontSize: '12px', margin: '0 0 18px' },
        }, t('checked', { date: formatDate(data.checkedAt) })) : null),
      state.error ? React.createElement('p', {
        role: 'alert', style: { ...quiet, color: T.error },
      }, t('error') + state.error) : null,
      data.profile && data.profile.error ? React.createElement('p', {
        role: 'alert', style: { ...quiet, color: T.error },
      }, errorMessage(data.profile.error, t('unknownError'))) : null,
      React.createElement('div', { role: 'status', 'aria-live': 'polite', style: quiet }, notice),
      confirmation ? React.createElement('section', {
        role: 'region', 'aria-labelledby': 'plugin-health-confirm-title',
        onKeyDown: (event) => { if (event.key === 'Escape') dismissConfirmation(); },
        style: { padding: '14px', margin: '16px 0', border: T.border, background: T.surface },
      },
        React.createElement('h3', { id: 'plugin-health-confirm-title', style: heading },
          t(confirmation.action === 'fix' ? 'confirmReinstall' : 'confirmRemove')),
        React.createElement('div', { style: { overflowWrap: 'anywhere' } }, confirmation.plugin),
        React.createElement('p', { style: quiet },
          t(confirmation.action === 'fix' ? 'confirmReinstallBody' : 'confirmRemoveBody')),
        React.createElement('button', {
          ref: confirmationRef, type: 'button', onClick: dismissConfirmation, style: buttonStyle,
        }, t('cancel')),
        React.createElement('button', {
          type: 'button', onClick: runAction, style: { ...buttonStyle, marginLeft: '8px' },
        }, t(confirmation.action === 'fix' ? 'confirmFix' : 'confirm'))) : null,
      state.phase === 'ready' ? React.createElement(React.Fragment, null,
        React.createElement('section', { style: { margin: '22px 0' } },
          React.createElement('h3', { style: heading }, t('issues')),
          issues.length ? issues.map((row) => React.createElement('div', {
            key: row.name,
            style: { borderLeft: '3px solid ' + T.error, padding: '9px 12px', marginBottom: '9px', background: T.surface },
          },
            React.createElement('strong', { style: { fontSize: '13px', overflowWrap: 'anywhere' } }, row.name),
            React.createElement('p', { style: { ...quiet, margin: '4px 0' } }, healthReason(row, t)),
            actionButtons(row))) : React.createElement('p', { style: quiet }, t('noIssues'))),
        React.createElement('section', null,
          React.createElement('h3', { style: heading }, t('plugins') + ' (' + total + ')'),
          !rows.length ? React.createElement('p', { style: quiet }, t('noData')) : null,
          rows.map((row) => React.createElement('article', {
            key: row.name, style: { borderTop: T.border, padding: '13px 0' },
          },
            React.createElement('div', {
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' },
            },
              React.createElement('strong', { style: { fontSize: '13px', overflowWrap: 'anywhere' } }, row.name),
              React.createElement('span', { style: { color: colorFor(row), fontSize: '12px' } }, statusText(row))),
            React.createElement('div', { style: { ...quiet, fontSize: '12px' } },
              row.version || (row.firstParty ? t('bundled') : t('notInstalled'))),
            React.createElement('p', { style: { ...quiet, margin: '5px 0 9px' } }, healthReason(row, t)),
            actionButtons(row)))),
        React.createElement('details', { style: { marginTop: '24px', borderTop: T.border, paddingTop: '14px' } },
          React.createElement('summary', { style: { cursor: 'pointer', fontSize: '14px', fontWeight: 600 } }, t('matrix')),
          React.createElement('p', { style: quiet }, t('historical')),
          data.upgrade && data.upgrade.worse > 0 ? React.createElement('div', null,
            React.createElement('h4', { style: heading }, t('preview')),
            React.createElement('p', { style: quiet }, t('previewBody', {
              count: data.upgrade.worse, version: data.upgrade.latest, running: data.upgrade.running,
            }))) : null,
          versions.length ? React.createElement('div', { style: { overflowX: 'auto' } },
            React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
              React.createElement('caption', { style: { ...quiet, textAlign: 'left' } }, t('matrix')),
              React.createElement('thead', null,
                React.createElement('tr', null, [t('plugin'), ...versions].map((value) =>
                  React.createElement('th', { key: value, scope: 'col', style: tableCell }, value)))),
              React.createElement('tbody', null, rows.map((row) =>
                React.createElement('tr', { key: row.name },
                  React.createElement('th', { scope: 'row', style: tableCell }, row.name),
                  versions.map((version) => {
                    const cells = (row.cells || []).filter((cell) => cell.dsh === version);
                    return React.createElement('td', { key: version, style: tableCell },
                      cells.length ? cells.map((cell, index) => React.createElement('div', { key: index },
                        t(cell.status === 'active' ? 'probeActive'
                          : cell.status === 'awaiting-service' ? 'probeWaiting' : 'probeFailure'),
                        cell.composition ? ' (' + cell.composition + ')' : '')) : t('matrixUnavailable'));
                  })))))) : null,
          React.createElement('h4', { style: { ...heading, marginTop: '18px' } }, t('capabilities')),
          rows.map((row) => React.createElement('p', { key: row.name, style: quiet },
            row.name + ': ' + ((row.audit && row.audit.observed || []).map((item) => item.capability).join(', ')
              || t('noCapabilities')))),
          data.conflicts && data.conflicts.length ? React.createElement('section', null,
            React.createElement('h4', { style: heading }, t('conflicts')),
            React.createElement('p', { style: quiet }, t('conflictBody')),
            data.conflicts.map((conflict) => React.createElement('p', { key: conflict.slot, style: quiet },
              conflict.slot + ': ' + (conflict.plugins || []).join(', ')))) : null)) : null);
    }

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = {}; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        return this.state.error ? React.createElement('div', { role: 'alert', style: quiet },
          this.props.t('panelError') + errorMessage(this.state.error, this.props.t('unknownError')))
          : this.props.children;
      }
    }

    function apply(ctx) {
      const t = ctx.locale ? ctx.locale.bind(NS) : (key, vars) =>
        (DICT.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars && vars[name] != null ? vars[name] : ''));
      if (ctx.locale) ctx.effect(() => ctx.locale.register(NS, DICT), NS + ': dictionaries');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'plugin-lint', order: 80, label: () => t('title'),
      }, () => React.createElement(Boundary, { t }, React.createElement(Panel, { t }))));
    }
    return { apply, inject: ['slots', 'locale'] };
  },
});
