window.__ModuleLoader__.load({
  id: '@local/dsh-codex-compat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const dictionaries = {
      zh: {
        title: '兼容方式', headers: '直连加头', proxy: '本地代理', off: '已关闭',
        headerHint: '直接请求上游，自动添加 Codex 兼容头。',
        proxyHint: '经本机代理请求上游，同时设置兼容头与 User-Agent。',
        hint: '选择后自动保存并生效，只启用一种方式。提供商地址会自动切换，密钥、协议和模型保持原设置。',
        current: '实际生效：', switching: '正在切换…', starting: '正在读取状态…',
        failed: '切换未完成', retry: '重试所选方式', disable: '关闭兼容',
        unavailable: '配置暂不可用，请确认 Host 插件已启用。', refused: '未能保存，请刷新配置后重试。',
        providers: '目标提供商：', empty: '暂无',
      },
      en: {
        title: 'Compatibility mode', headers: 'Direct headers', proxy: 'Local proxy', off: 'Off',
        headerHint: 'Call the upstream directly with Codex compatibility headers.',
        proxyHint: 'Use a loopback proxy with compatibility headers and User-Agent.',
        hint: 'Changes save and apply automatically. Only one mode is active. Provider URLs change automatically; keys, protocols and models retain their settings.',
        current: 'Active mode: ', switching: 'Switching…', starting: 'Reading status…',
        failed: 'Switch incomplete', retry: 'Retry selected mode', disable: 'Turn compatibility off',
        unavailable: 'Configuration is unavailable. Check that the Host plugin is enabled.', refused: 'Could not save. Refresh the configuration and retry.',
        providers: 'Target providers: ', empty: 'None',
      },
    };
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale');
        ctx.effect(() => locale.register('codex-compat', 'en', dictionaries.en));
        ctx.effect(() => locale.register('codex-compat', 'zh', dictionaries.zh));
        const t = locale.bind('codex-compat');
        const control = {
          color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
          padding: '12px 14px', textAlign: 'left', cursor: 'pointer', font: 'inherit',
        };
        function Configuration({ view, form }) {
          React.useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot());
          const [busy, setBusy] = React.useState(false);
          const [failure, setFailure] = React.useState('');
          const value = form?.state.value;
          const state = value?.state;
          if (view === 'summary') return t('hint');
          if (!value) return h('p', null, t('unavailable'));
          const disabled = busy || !form.state.writable || state?.phase === 'switching';
          async function select(mode) {
            setBusy(true);
            setFailure('');
            try {
              const accepted = await form.mutate([
                { op: 'set', path: ['mode'], value: mode },
                { op: 'set', path: ['requestId'], value: (value.requestId || 0) + 1 },
              ], form.state.revision);
              if (!accepted) setFailure(t('refused'));
            } catch { setFailure(t('refused')); }
            finally { setBusy(false); }
          }
          return h('div', { style: { display: 'grid', gap: 16, maxWidth: 640, color: 'var(--dsw-alias-label-primary)' } },
            h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, t('hint')),
            h('div', { role: 'radiogroup', 'aria-label': t('title'), style: { display: 'grid', gap: 10 } },
              ...['headers', 'proxy'].map(mode => h('button', {
                key: mode, type: 'button', role: 'radio', 'aria-checked': value.mode === mode,
                disabled, onClick: () => select(mode),
                style: { ...control, borderColor: value.mode === mode ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)', opacity: disabled ? 0.6 : 1 },
              }, h('strong', null, t(mode)), h('div', { style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 } }, t(mode === 'headers' ? 'headerHint' : 'proxyHint')))),
            ),
            h('div', { role: 'status', 'aria-live': 'polite', style: { lineHeight: 1.6 } },
              !state?.phase || state.phase === 'starting' ? t('starting') :
                state.phase === 'switching' ? t('switching') : t('current') + t(state.mode || 'off'),
              h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('providers') + (state?.providers?.join(', ') || t('empty'))),
              state?.message && h('div', { style: { color: state.phase === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' } }, state.message),
            ),
            failure && h('p', { role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, failure),
            h('div', { style: { display: 'flex', gap: 10 } },
              state?.phase === 'error' && h('button', { type: 'button', disabled, style: control, onClick: () => select(value.mode) }, t('retry')),
              h('button', { type: 'button', disabled, style: control, onClick: () => select('off') }, t('disable')),
            ),
          );
        }
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@local/dsh-codex-compat#local-codex-compat',
        }, Configuration));
      },
    };
  },
});
