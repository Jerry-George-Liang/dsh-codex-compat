import Schema from '@deepseek-ai/schemastery';
import { addCompatibilityHeaders, defaults, matchesRequest, prepareConfig } from './compat.js';
import { ModeController } from './controller.js';
import { createTaskScope } from './task-scope.js';

export const name = 'local-codex-compat';
export const inject = ['settings', 'configEditor', 'credentials', 'tools', 'webServer'];
export const Config = Schema.object({
  mode: Schema.union(['off', 'headers', 'proxy']).default(defaults.mode).volatile().description('headers：直连加头；proxy：本地代理；off：关闭。选择后即时应用。'),
  requestId: Schema.number().default(0).volatile(),
  state: Schema.any().default({}).volatile().description('插件报告的实际状态；请勿手工修改。'),
  upstreamBaseURL: Schema.string().default(defaults.upstreamBaseURL).description('上游 HTTPS API 基址；仅匹配这个完整基址。'),
  providerIds: Schema.array(Schema.string()).default([]).description('目标提供商 ID 白名单；留空则按上游基址匹配。'),
  port: Schema.number().default(defaults.port).description('代理端口，只监听 127.0.0.1。'),
  credentialRef: Schema.string().default(defaults.credentialRef).role('credential-ref').description('旧版代理配置引用名；自动切换采用提供商 apiKeyEnv。'),
  originator: Schema.string().default(defaults.originator),
  windowId: Schema.string().default('').description('固定 UUID；留空则每次插件启动生成。'),
  userAgent: Schema.string().default(defaults.userAgent),
  idleTimeoutMs: Schema.number().default(defaults.idleTimeoutMs),
}).default({});

export async function apply(ctx, source) {
  const settings = ctx.get('settings');
  const editor = ctx.get('configEditor');
  const credentials = ctx.get('credentials');
  const tools = ctx.get('tools');
  const namespace = ctx.fiber.entry.options.id;
  const config = prepareConfig({ ...source, mode: source.mode.get() });
  const taskScope = createTaskScope(ctx.get('webServer'));
  let pending = Promise.resolve();
  let requested = false;
  const requestMode = mode => {
    requested = true;
    return (pending = taskScope.run(() => controller.setMode(mode)));
  };
  let live = true;
  // Module versions can overlap briefly during Loader replacement. A successor
  // waits outside apply() for the previous instance to restore its routes.
  const lifetimes = globalThis[Symbol.for('@local/dsh-codex-compat/lifetimes')] ??= new Map();
  const previous = lifetimes.get(namespace);
  let finished;
  const lifetime = { done: new Promise(resolve => { finished = resolve; }) };
  lifetimes.set(namespace, lifetime);
  const controller = new ModeController(config, {
    waitForPrevious: previous?.done,
    readProviders: () => {
      const ids = new Set(editor.entries().filter(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai').map(entry => entry.options.id));
      return settings.describe().filter(section => ids.has(section.ns));
    },
    mutate: (ns, ops, revision) => settings.mutate(ns, ops, revision),
    resolveKey: async ref => (await credentials.resolve(ref))?.value,
    publish: async state => {
      if (!live) return;
      // State is observational. A failed status write must not undo a completed route change.
      try { await settings.update(namespace, { state }); }
      catch { console.warn('[codex-compat] Unable to publish mode status'); }
    },
  });
  ctx.effect(() => () => {
    live = false;
    // ConfigEditor's lock must be released before disposal edits provider URLs.
    // The successor's controller waits for this promise before changing routes.
    void taskScope.run(() => controller.dispose())
      .catch(() => console.warn('[codex-compat] Provider route restoration failed; check model settings'))
      .finally(() => {
        taskScope.close();
        finished();
        if (lifetimes.get(namespace) === lifetime) lifetimes.delete(namespace);
      });
  });
  const service = {
    status: () => controller.state,
    async switchMode(mode) {
      if (!['headers', 'proxy', 'off'].includes(mode)) throw new Error('Invalid compatibility mode');
      await settings.update(namespace, { mode, requestId: source.requestId.get() + 1 });
      await pending;
      return controller.state;
    },
  };
  ctx.provide('codexCompat', service);
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (controller.mode === 'headers' && matchesRequest(request, config)) addCompatibilityHeaders(headers, config);
    return next();
  });
  // Loader commits volatile refs before this notification; never await a second settings
  // edit inside the notification, which is dispatched while the profile write is locked.
  ctx.on('loader/volatile-update', paths => {
    if (live && paths.some(path => path[0] === 'mode' || path[0] === 'requestId')) {
      void requestMode(source.mode.get()).catch(() => console.warn('[codex-compat] Mode switch interrupted'));
    }
  });
  tools.register({
    name: 'codex_compat',
    description: '查看 Codex 渠道兼容插件的实际状态，或在直连加头、本地代理、关闭之间切换。切换会自动更新匹配提供商的 Base URL，对当前 profile 所有会话生效。返回实际模式、目标提供商和失败原因。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'switch'], description: 'status 查看状态；switch 切换模式。' },
      mode: { type: 'string', enum: ['headers', 'proxy', 'off'], description: 'switch 时必填。' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return JSON.stringify(args.action === 'status' ? service.status() : await service.switchMode(args.mode));
    },
  });
  // Startup may precede this fiber becoming visible to settings.describe(). The
  // next event-loop turn reads the latest selection and joins the serialized queue.
  setImmediate(() => { if (live && !requested) void requestMode(source.mode.get()).catch(() => console.warn('[codex-compat] Startup interrupted')); });
}
