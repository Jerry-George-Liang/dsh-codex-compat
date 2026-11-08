import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const { apply, Config } = await import(new URL(`../${pkg.exports['.']}`, import.meta.url));
import { defaults } from '../compat.js';

// Exercise the actual packaged Host entry, including volatile settings notifications
// under an exclusive write queue, the native waterfall, and the registered agent tool.
async function hostFixture() {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const upstream = 'https://gateway.invalid/coding/v1';
  const refs = { mode: 'headers', state: {}, requestId: 0 };
  const source = { ...defaults, upstreamBaseURL: upstream, port, idleTimeoutMs: 100 };
  for (const key of Object.keys(refs)) source[key] = { get: () => refs[key] };
  const listeners = new Map();
  const effects = [];
  const services = new Map();
  const routes = new Map();
  const carrier = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (handler) handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  carrier.listen(0, '127.0.0.1');
  await once(carrier, 'listening');
  services.set('webServer', {
    getOrigin: () => `http://127.0.0.1:${carrier.address().port}`,
    register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
  });
  const transaction = new AsyncLocalStorage();
  const notices = new EventEmitter();
  const provider = { baseURL: upstream, apiKeyEnv: 'TEST_KEY', api: 'openai-responses', models: [{ id: 'test-model' }] };
  let revision = 0;
  let lock = Promise.resolve();
  const enqueue = run => {
    // Match HMR's ALS guard: deferring a callback alone still inherits this flag.
    if (transaction.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'));
    const operation = lock.then(() => transaction.run(true, run));
    lock = operation.catch(() => {});
    return operation;
  };
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: { test: structuredClone(provider) } } }],
    update: (_ns, patch) => enqueue(async () => {
      for (const [key, value] of Object.entries(patch)) refs[key] = value;
      listeners.get('loader/volatile-update')?.(Object.keys(patch).map(key => [key]));
      if (patch.state) notices.emit('state', patch.state);
    }),
    mutate: (_ns, ops, expected) => enqueue(async () => {
      assert.equal(expected, revision);
      for (const op of ops) provider[op.path[2]] = op.value;
      revision++;
    }),
  };
  services.set('settings', settings);
  services.set('configEditor', { entries: () => [{ options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }] });
  services.set('credentials', { resolve: async ref => { assert.equal(ref, 'TEST_KEY'); return { value: 'local-test-key' }; } });
  let tool;
  services.set('tools', { register: definition => { tool = definition; } });
  const ctx = {
    fiber: { entry: { options: { id: `test-codex-${port}` } } },
    get: key => services.get(key),
    provide: (key, value) => { services.set(key, value); },
    on: (event, fn) => { listeners.set(event, fn); },
    effect: effect => { effects.push(effect()); },
  };
  await enqueue(() => apply(ctx, source));
  return {
    refs, provider, listeners, settings, routes,
    waitForMode(mode) {
      if (refs.state.mode === mode && refs.state.phase === 'ready') return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = state => {
          if (state.mode !== mode || state.phase !== 'ready') return;
          clearTimeout(timer); notices.off('state', done); resolve();
        };
        const timer = setTimeout(() => { notices.off('state', done); reject(new Error(`Mode ${mode} did not become ready`)); }, 2000);
        notices.on('state', done);
      });
    },
    get tool() { return tool; },
    service: services.get('codexCompat'),
    async close() {
      await enqueue(async () => { for (const dispose of effects.reverse()) dispose(); });
      // The next instance's lifetime barrier is the public signal that detached
      // teardown has completed its settings writes and released the listener.
      const lifetime = globalThis[Symbol.for('@local/dsh-codex-compat/lifetimes')]?.get(ctx.fiber.entry.options.id);
      await lifetime?.done;
      await lock;
      await new Promise(resolve => carrier.close(resolve));
      assert.equal(routes.size, 0);
    },
  };
}

test('packaged Host mode tool shares volatile write path, applies immediately, and keeps waterfall continuation', async () => {
  const f = await hostFixture();
  const exec = { signal: new AbortController().signal };
  try {
    // Invoke before setImmediate startup: startup must use the latest persisted request.
    const status = JSON.parse(await f.tool.execute({ action: 'switch', mode: 'proxy' }, exec));
    assert.equal(status.mode, 'proxy');
    assert.equal(status.phase, 'ready');
    assert.match(f.provider.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(await f.tool.execute({ action: 'status' }, exec)).mode, 'proxy');
    await f.service.switchMode('headers');
    assert.equal(f.provider.baseURL, 'https://gateway.invalid/coding/v1');
    const headers = new Headers();
    let continued = false;
    f.listeners.get('llm-pi-ai/request-headers')({ provider: 'test', baseURL: f.provider.baseURL }, headers, () => { continued = true; return headers; });
    assert.equal(continued, true);
    assert.equal(headers.get('originator'), 'codex_cli_rs');
    assert.equal(f.refs.state.mode, 'headers');
    await f.tool.execute({ action: 'switch', mode: 'off' }, exec);
    const disabledHeaders = new Headers();
    f.listeners.get('llm-pi-ai/request-headers')({ provider: 'test', baseURL: f.provider.baseURL }, disabledHeaders, () => disabledHeaders);
    assert.equal(disabledHeaders.has('originator'), false);
    assert.equal(f.provider.api, 'openai-responses');
    assert.equal(f.provider.apiKeyEnv, 'TEST_KEY');
    assert.deepEqual(f.provider.models, [{ id: 'test-model' }]);
  } finally { await f.close(); }
});

test('native settings changes and disposal escape the inherited HMR transaction', async () => {
  const f = await hostFixture();
  try {
    await f.waitForMode('headers');
    assert.equal(f.routes.size, 0, 'one-shot handshake route is removed');
    await f.settings.update('codex', { mode: 'proxy', requestId: 1 });
    await f.waitForMode('proxy');
    assert.match(f.provider.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    await f.settings.update('codex', { mode: 'headers', requestId: 2 });
    await f.waitForMode('headers');
    assert.equal(f.provider.baseURL, 'https://gateway.invalid/coding/v1');
    await f.settings.update('codex', { mode: 'proxy', requestId: 3 });
    await f.waitForMode('proxy');
  } finally { await f.close(); }
  assert.equal(f.provider.baseURL, 'https://gateway.invalid/coding/v1', 'locked disposal restores the original route');
});

test('Host Config exposes live mode/request/status fields for the native configuration page', () => {
  assert.equal(typeof Config.toJSON(), 'object');
  const resolved = Config({ mode: 'proxy' });
  assert.equal(resolved.mode.get(), 'proxy');
  assert.equal(resolved.requestId.get(), 0);
  assert.deepEqual(resolved.state.get(), {});
  assert.equal(resolved.port, 3081);
});
