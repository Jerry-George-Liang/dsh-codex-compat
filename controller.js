import { createCompatibilityServer } from './compat.js';

const modes = ['off', 'headers', 'proxy'];
const canonical = value => {
  try { return new URL(value).href.replace(/\/+$/, ''); } catch { return ''; }
};

// Routes are changed through the Host settings service, with revision fences.
// Only baseURL is owned; keys, models, protocol, and concurrent edits are retained.
export class ModeController {
  constructor(config, { readProviders, mutate, resolveKey, publish = async () => {}, startProxy, waitForPrevious = Promise.resolve() }) {
    this.config = config;
    this.io = { readProviders, mutate, resolveKey, publish, startProxy };
    this.localURL = `http://127.0.0.1:${config.port}/v1`;
    this.mode = 'off';
    this.server = undefined;
    this.tail = Promise.resolve(waitForPrevious);
    this.closed = false;
    this.state = { mode: 'off', phase: 'starting', message: '', providers: [] };
  }

  targets() {
    return this.io.readProviders().flatMap(section => Object.entries(section.value.providers ?? {}).flatMap(([id, profile]) => {
      if (this.config.providerIds.length && !this.config.providerIds.includes(id)) return [];
      const url = canonical(profile.baseURL);
      if (url !== this.config.upstreamBaseURL && url !== this.localURL) return [];
      return [{ ns: section.ns, id, profile, revision: section.revision }];
    }));
  }

  setMode(mode) {
    if (!modes.includes(mode)) return Promise.reject(new Error('Invalid compatibility mode'));
    const operation = this.tail.then(() => this.transition(mode));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async report(phase, message = '') {
    this.state = { mode: this.mode, phase, message, providers: this.targets().map(row => row.id) };
    await this.io.publish(this.state);
    return this.state;
  }

  async route(targets, destination) {
    const changed = [];
    try {
      for (const ns of new Set(targets.map(row => row.ns))) {
        const rows = targets.filter(row => row.ns === ns && canonical(row.profile.baseURL) !== destination);
        if (!rows.length) continue;
        await this.io.mutate(ns, rows.map(row => ({ op: 'set', path: ['providers', row.id, 'baseURL'], value: destination })), rows[0].revision);
        changed.push(...rows);
      }
      return changed;
    } catch (error) {
      // A later namespace failed: restore only routes still carrying our write.
      let recoveryFailed = false;
      for (const row of changed.reverse()) {
        const section = this.io.readProviders().find(section => section.ns === row.ns);
        if (canonical(section?.value.providers?.[row.id]?.baseURL) !== destination) continue;
        try {
          await this.io.mutate(row.ns, [{ op: 'set', path: ['providers', row.id, 'baseURL'], value: row.profile.baseURL }], section.revision);
        } catch { recoveryFailed = true; }
      }
      const reason = error?.name === 'SettingsConflictError' ? '配置版本冲突' :
        String(error?.message).startsWith('llm-pi-ai:') ? '提供商配置校验未通过' :
        /not volatile/.test(error?.message) ? '字段不支持热更新' : '配置写入被拒绝';
      let detail = String(error?.message ?? error?.name ?? 'Unknown settings error').split('\n')[0];
      // Settings validates raw configuration, never resolved credential values. Mask
      // user-supplied transport secrets before showing its actionable failure detail.
      for (const section of this.io.readProviders()) for (const profile of Object.values(section.value.providers ?? {})) {
        for (const value of [profile.baseURL, ...Object.values(profile.headers ?? {})]) {
          if (typeof value === 'string' && value) detail = detail.replaceAll(value, '[redacted]');
        }
      }
      detail = detail.replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 400);
      throw new Error(recoveryFailed ? '提供商配置发生并发修改，部分路由未恢复；请检查模型设置。' : `${reason}，原路由已保留；${detail}`);
    }
  }

  proxyRef(targets = this.targets()) {
    if (targets.some(row => typeof row.profile.apiKeyEnv !== 'string' || !row.profile.apiKeyEnv.trim())) {
      throw new Error('目标提供商未指定密钥引用 apiKeyEnv；请先在模型设置中选择现有密钥引用。');
    }
    const refs = [...new Set(targets.map(row => row.profile.apiKeyEnv))];
    if (refs.length !== 1) throw new Error('目标提供商使用多个密钥引用；请通过 providerIds 选择使用同一密钥的提供商。');
    return refs[0];
  }

  async openProxy(targets) {
    const ref = this.proxyRef(targets);
    let timer;
    let key;
    try {
      key = await Promise.race([
        this.io.resolveKey(ref),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取密钥超时，原模式保留。')), Math.min(this.config.idleTimeoutMs, 10000)); }),
      ]);
    } catch { throw new Error('无法读取提供商密钥，原模式保留。'); }
    finally { clearTimeout(timer); }
    if (typeof key !== 'string' || !key.trim()) throw new Error('提供商密钥尚未配置，原模式保留。');
    if (this.closed) throw new Error('插件已停用。');
    const config = { ...this.config, credentialRef: ref };
    if (this.io.startProxy) return this.io.startProxy(config);
    const server = createCompatibilityServer(config, { resolveKey: () => this.io.resolveKey(this.proxyRef()) });
    await new Promise((resolve, reject) => {
      const fail = () => { server.stop(); reject(new Error('本地代理端口被占用或无法监听，原模式保留。')); };
      server.once('error', fail);
      server.listen(config.port, '127.0.0.1', () => { server.off('error', fail); resolve(); });
    });
    return server;
  }

  async transition(mode) {
    if (this.closed) throw new Error('插件已停用。');
    const previous = this.mode;
    let candidate;
    try {
      await this.report('switching');
      // Publishing status reconciles the profile and can advance provider revisions.
      // Read the routing snapshot only after that write, then refresh after preflight.
      const targets = this.targets();
      if (mode === 'proxy') {
        if (!targets.length) throw new Error('未找到匹配上游地址的 pi-ai 提供商；请先在模型设置中配置提供商。');
        this.proxyRef(targets);
        candidate = this.server ?? await this.openProxy(targets);
        if (this.closed) throw new Error('插件已停用。');
        const current = this.targets();
        if (!current.length) throw new Error('目标提供商配置在切换期间已修改，请重新选择方式。');
        this.proxyRef(current);
        await this.route(current, this.localURL);
        this.server = candidate;
        candidate = undefined;
        this.mode = 'proxy';
      } else {
        // Exact upstream matching means direct headers cannot affect a local proxy request.
        this.mode = mode;
        await this.route(targets, this.config.upstreamBaseURL);
        await this.server?.stop();
        this.server = undefined;
      }
      return await this.report('ready', targets.length ? '' : '未找到匹配上游地址的提供商；新增提供商后重新选择模式即可。');
    } catch (error) {
      this.mode = previous;
      // If rollback itself failed, preserve the live listener serving remaining local routes.
      if (candidate && this.targets().some(row => canonical(row.profile.baseURL) === this.localURL)) {
        this.server = candidate;
        this.mode = 'proxy';
      } else if (candidate && candidate !== this.server) await candidate.stop();
      if (!this.server) {
        try { await this.route(this.targets(), this.config.upstreamBaseURL); }
        catch { error = new Error(`${error.message} 本地路由恢复失败，请检查模型设置。`); }
      }
      await this.report('error', error.message);
      return this.state;
    }
  }

  async restoreLocalRoutes() {
    // Disposal must not roll an already restored namespace back to a dead proxy.
    // Re-read each namespace after a conflict, preserving every concurrent edit.
    for (let attempt = 0; attempt < 3; attempt++) {
      const namespaces = new Set(this.targets().filter(row => canonical(row.profile.baseURL) === this.localURL).map(row => row.ns));
      if (!namespaces.size) return;
      for (const ns of namespaces) {
        const rows = this.targets().filter(row => row.ns === ns && canonical(row.profile.baseURL) === this.localURL);
        if (!rows.length) continue;
        try {
          await this.io.mutate(ns, rows.map(row => ({ op: 'set', path: ['providers', row.id, 'baseURL'], value: this.config.upstreamBaseURL })), rows[0].revision);
        } catch { /* Retry from fresh values; a manual URL edit is never overwritten. */ }
      }
    }
    if (this.targets().some(row => canonical(row.profile.baseURL) === this.localURL)) {
      throw new Error('无法恢复本地代理地址，请在模型设置中恢复上游地址。');
    }
  }

  async dispose() {
    this.closed = true;
    await this.tail;
    try { await this.restoreLocalRoutes(); }
    finally { await this.server?.stop(); this.server = undefined; this.mode = 'off'; }
  }
}
