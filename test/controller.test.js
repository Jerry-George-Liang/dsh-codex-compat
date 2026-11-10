import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ModeController } from '../controller.js';
import { prepareConfig, matchesRequest } from '../compat.js';

const upstream = 'https://gateway.invalid/coding/v1';
const profile = (baseURL = upstream, apiKeyEnv = 'PROVIDER_KEY') => ({ baseURL, apiKeyEnv, api: 'openai-responses', models: [{ id: 'codex-test' }], custom: { keep: true } });
function fixture(overrides = {}, sections) {
  const config = prepareConfig({ upstreamBaseURL: upstream, idleTimeoutMs: 100, ...overrides.config });
  const documents = sections ?? [{ ns: 'llm-pi-ai', value: { providers: { codex: profile(), unrelated: profile('https://other.invalid/v1') }, extra: true }, revision: 0 }];
  const events = [];
  const servers = [];
  const io = {
    readProviders: () => structuredClone(documents),
    async mutate(ns, ops, revision) {
      const section = documents.find(section => section.ns === ns);
      assert.equal(section.revision, revision, 'stale provider update');
      events.push(['route', ns, ops]);
      for (const op of ops) section.value.providers[op.path[1]].baseURL = op.value;
      section.revision++;
    },
    async resolveKey(ref) { events.push(['credential', ref]); return 'test-key'; },
    async publish(state) { events.push(['state', structuredClone(state)]); },
    async startProxy(config) {
      const server = { config, stopped: false, async stop() { events.push(['stop']); this.stopped = true; } };
      servers.push(server);
      events.push(['listen']);
      return server;
    },
    ...overrides.io,
  };
  const controller = new ModeController(config, io);
  return { controller, config, documents, events, servers, io: controller.io };
}

test('two-way switching changes only scoped URLs, preserves credentials/protocol/models, and is mutually exclusive', async () => {
  const f = fixture();
  const initial = structuredClone(f.documents[0].value);
  const c = f.controller;
  assert.equal((await c.setMode('headers')).mode, 'headers');
  assert.equal((await c.setMode('proxy')).mode, 'proxy');
  assert.equal(f.documents[0].value.providers.codex.baseURL, c.localURL);
  assert.equal(f.events.findIndex(e => e[0] === 'listen') < f.events.findIndex(e => e[0] === 'route'), true);
  assert.equal(matchesRequest({ baseURL: c.localURL, provider: 'codex' }, f.config), false);
  assert.equal(f.documents[0].value.providers.codex.apiKeyEnv, 'PROVIDER_KEY');
  assert.equal(f.events.find(e => e[0] === 'credential')[1], 'PROVIDER_KEY');
  assert.equal((await c.setMode('headers')).mode, 'headers');
  assert.equal(f.servers[0].stopped, true);
  assert.deepEqual(f.documents[0].value, initial);
  assert.equal((await c.setMode('off')).mode, 'off');
  await c.dispose();
});

test('provider whitelist excludes another matching upstream', async () => {
  const f = fixture({ config: { providerIds: ['codex'] } });
  f.documents[0].value.providers.otherCodex = profile();
  await f.controller.setMode('proxy');
  assert.equal(f.documents[0].value.providers.otherCodex.baseURL, upstream);
  await f.controller.dispose();
});

test('missing credentials and listen failures retain the direct mode and route', async () => {
  for (const io of [
    { resolveKey: async () => undefined },
    { resolveKey: async () => { throw new Error('DO_NOT_LEAK_SECRET'); } },
    { startProxy: async () => { throw new Error('port is busy'); } },
  ]) {
    const f = fixture({ io });
    await f.controller.setMode('headers');
    const state = await f.controller.setMode('proxy');
    assert.equal(state.mode, 'headers');
    assert.equal(state.phase, 'error');
    assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
    assert.equal(state.message.includes('DO_NOT_LEAK_SECRET'), false);
    await f.controller.dispose();
  }
});

test('multiple credential refs fail before opening a proxy', async () => {
  const f = fixture();
  f.documents[0].value.providers.second = profile(upstream, 'OTHER_KEY');
  const state = await f.controller.setMode('proxy');
  assert.equal(state.phase, 'error');
  assert.equal(f.servers.length, 0);
  assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  await f.controller.dispose();
});

test('provider without explicit auth ref fails before redirecting callers with ambient credentials', async () => {
  const f = fixture();
  delete f.documents[0].value.providers.codex.apiKeyEnv;
  const state = await f.controller.setMode('proxy');
  assert.equal(state.phase, 'error');
  assert.match(state.message, /apiKeyEnv/);
  assert.equal(f.servers.length, 0);
  assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  await f.controller.dispose();
});

test('routing uses revisions refreshed after status publication and async credential preflight', async () => {
  const f = fixture();
  f.io.publish = async () => { f.documents[0].revision++; };
  f.io.resolveKey = async () => { f.documents[0].revision++; return 'test-key'; };
  assert.equal((await f.controller.setMode('proxy')).phase, 'ready');
  assert.equal(f.documents[0].value.providers.codex.baseURL, f.controller.localURL);
  assert.equal((await f.controller.setMode('headers')).phase, 'ready');
  assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  await f.controller.dispose();
});

test('revision conflict closes the candidate, retains direct routing, and allows retry', async () => {
  const f = fixture();
  await f.controller.setMode('headers');
  const mutate = f.io.mutate;
  let refuse = true;
  f.io.mutate = async (...args) => { if (refuse) throw new Error('conflict'); return mutate(...args); };
  const state = await f.controller.setMode('proxy');
  assert.equal(state.mode, 'headers');
  assert.equal(state.phase, 'error');
  assert.equal(f.servers[0].stopped, true);
  refuse = false;
  assert.equal((await f.controller.setMode('proxy')).mode, 'proxy');
  await f.controller.dispose();
});

test('rapid mode requests serialize; each previous listener closes before the next starts', async () => {
  const f = fixture();
  await Promise.all(['proxy', 'headers', 'proxy', 'headers', 'off', 'proxy'].map(mode => f.controller.setMode(mode)));
  assert.equal(f.controller.mode, 'proxy');
  assert.equal(f.servers.length, 3);
  assert.deepEqual(f.servers.map(s => s.stopped), [true, true, false]);
  assert.equal(f.documents[0].value.providers.codex.baseURL, f.controller.localURL);
  await f.controller.dispose();
  assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  assert.equal(f.servers[2].stopped, true);
});

test('disposal retains a manually edited route and preserves other provider changes', async () => {
  const f = fixture();
  await f.controller.setMode('proxy');
  f.documents[0].value.providers.codex.baseURL = 'https://manually-changed.invalid/v1';
  f.documents[0].value.providers.codex.models.push({ id: 'new' });
  f.documents[0].revision++;
  await f.controller.dispose();
  assert.equal(f.documents[0].value.providers.codex.baseURL, 'https://manually-changed.invalid/v1');
  assert.equal(f.documents[0].value.providers.codex.models.length, 2);
  await assert.rejects(f.controller.setMode('headers'), /停用/);
});

test('startup repairs stale local proxy routes when headers mode is selected or proxy fails', async () => {
  for (const mode of ['headers', 'off', 'proxy']) {
    const f = fixture({ io: { resolveKey: async () => undefined } });
    f.documents[0].value.providers.codex.baseURL = f.controller.localURL;
    await f.controller.setMode(mode);
    assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
    await f.controller.dispose();
  }
});

test('multi-namespace failure rolls back earlier namespace writes without replacing unrelated config', async () => {
  const sections = [
    { ns: 'first', value: { providers: { codex: profile() } }, revision: 0 },
    { ns: 'second', value: { providers: { codex2: profile() } }, revision: 0 },
  ];
  const f = fixture({}, sections);
  await f.controller.setMode('headers');
  const mutate = f.io.mutate;
  f.io.mutate = async (ns, ...args) => {
    if (ns === 'second') throw new Error('configuration conflict');
    return mutate(ns, ...args);
  };
  const state = await f.controller.setMode('proxy');
  assert.equal(state.mode, 'headers');
  assert.equal(state.phase, 'error');
  assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  assert.equal(f.documents[1].value.providers.codex2.baseURL, upstream);
  assert.equal(f.servers[0].stopped, true);
  await f.controller.dispose();
});

test('disposal retries a revision conflict and retains a manual edit during retry', async () => {
  const f = fixture();
  await f.controller.setMode('proxy');
  const mutate = f.io.mutate;
  let calls = 0;
  f.io.mutate = async (...args) => {
    if (++calls === 1) {
      f.documents[0].value.providers.codex.models.push({ id: 'concurrent-model' });
      f.documents[0].revision++;
      throw new Error('concurrent edit');
    }
    return mutate(...args);
  };
  await f.controller.dispose();
  assert.equal(calls, 2);
  assert.equal(f.documents[0].value.providers.codex.models.at(-1).id, 'concurrent-model');
  assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  assert.equal(f.servers[0].stopped, true);
});

test('replacement waits for old pending work and route restoration before starting', async () => {
  let releaseKey;
  const old = fixture({ io: { resolveKey: () => new Promise(resolve => { releaseKey = resolve; }) } });
  const pending = old.controller.setMode('proxy');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseKey, 'function');
  const retiring = old.controller.dispose();
  const replacement = fixture({ io: { waitForPrevious: retiring } }, old.documents);
  const switching = replacement.controller.setMode('proxy');
  releaseKey('test-key');
  await Promise.all([pending, retiring, switching]);
  assert.equal(replacement.controller.mode, 'proxy');
  assert.equal(replacement.documents[0].value.providers.codex.baseURL, replacement.controller.localURL);
  assert.equal(replacement.servers[0].stopped, false);
  await replacement.controller.dispose();
});

test('occupied preferred port falls back to an OS-assigned port before routing', async () => {
  const blocker = http.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const preferredPort = blocker.address().port;
  const f = fixture({ config: { port: preferredPort }, io: { startProxy: undefined } });
  try {
    await f.controller.setMode('headers');
    const state = await f.controller.setMode('proxy');
    assert.equal(state.mode, 'proxy');
    assert.equal(state.phase, 'ready');
    assert.notEqual(f.controller.server.address().port, preferredPort);
    assert.equal(f.documents[0].value.providers.codex.baseURL, state.proxyBaseURL);
    const health = await fetch(state.proxyBaseURL.replace('/v1', '/health'));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).baseURL, state.proxyBaseURL);
    const saved = f.events.find(e => e[0] === 'state' && e[1].proxyBaseURL === state.proxyBaseURL);
    assert(f.events.indexOf(saved) < f.events.findIndex(e => e[0] === 'route'));
    assert.equal((await f.controller.setMode('headers')).phase, 'ready');
    assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  } finally {
    await f.controller.dispose();
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('bounded credential wait reports failure without redirecting providers', async () => {
  const slow = fixture({ config: { idleTimeoutMs: 20 }, io: { resolveKey: () => new Promise(() => {}) } });
  assert.equal((await slow.controller.setMode('proxy')).phase, 'error');
  assert.equal(slow.documents[0].value.providers.codex.baseURL, upstream);
  await slow.controller.dispose();
});

test('Windows reserved port EACCES falls back to an OS-assigned listener', async t => {
  const attempts = [];
  const listen = http.Server.prototype.listen;
  const mocked = mock.method(http.Server.prototype, 'listen', function (port, ...args) {
    attempts.push(port);
    if (attempts.length === 1) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('reserved port'), { code: 'EACCES' })));
      return this;
    }
    return listen.call(this, port, ...args);
  });
  t.after(() => mocked.mock.restore());
  const f = fixture({ io: { startProxy: undefined } });
  try {
    const state = await f.controller.setMode('proxy');
    assert.deepEqual(attempts, [3081, 0]);
    assert.equal(state.phase, 'ready');
    assert.equal(state.proxyBaseURL, `http://127.0.0.1:${f.controller.server.address().port}/v1`);
  } finally { await f.controller.dispose(); }
});

test('unrecoverable listen error includes its code and keeps direct routes', async t => {
  const mocked = mock.method(http.Server.prototype, 'listen', function () {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('reserved port'), { code: 'EACCES' })));
    return this;
  });
  t.after(() => mocked.mock.restore());
  const f = fixture({ io: { startProxy: undefined } });
  try {
    await f.controller.setMode('headers');
    const state = await f.controller.setMode('proxy');
    assert.equal(state.phase, 'error');
    assert.equal(state.mode, 'headers');
    assert.match(state.message, /EACCES/);
    assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  } finally { await f.controller.dispose(); }
});

test('OS-assigned ports and saved proxy addresses recover across restart without touching other URLs', async () => {
  const oldURL = 'http://127.0.0.1:12345/v1';
  const otherURL = 'http://127.0.0.1:12346/v1';
  for (const mode of ['headers', 'off', 'proxy']) {
    const f = fixture({ config: { port: 0 }, io: { startProxy: undefined, previousProxyURL: oldURL } });
    f.documents[0].value.providers.codex.baseURL = oldURL;
    f.documents[0].value.providers.unrelated.baseURL = otherURL;
    try {
      const state = await f.controller.setMode(mode);
      assert.equal(state.phase, 'ready');
      assert.equal(f.documents[0].value.providers.codex.baseURL, mode === 'proxy' ? state.proxyBaseURL : upstream);
      assert.equal(f.documents[0].value.providers.unrelated.baseURL, otherURL);
      if (mode === 'proxy') assert(f.controller.server.address().port > 0);
    } finally { await f.controller.dispose(); }
    assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
  }
  const f = fixture({ io: { previousProxyURLs: [oldURL, otherURL, 'https://other.invalid/v1', 'http://127.0.0.1:99999/v1'] } });
  f.documents[0].value.providers.codex.baseURL = oldURL;
  f.documents[0].value.providers.second = profile(otherURL);
  f.documents[0].value.providers.unrelated.baseURL = 'https://other.invalid/v1';
  try {
    await f.controller.setMode('headers');
    assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
    assert.equal(f.documents[0].value.providers.second.baseURL, upstream);
    assert.equal(f.documents[0].value.providers.unrelated.baseURL, 'https://other.invalid/v1');
  } finally { await f.controller.dispose(); }
});

test('real proxy listens before routing, stops, and rebinds after a round trip without inference', async () => {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const f = fixture({ config: { port }, io: { startProxy: undefined } });
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.controller.setMode('proxy')).phase, 'ready');
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).mode, 'proxy');
      f.documents[0].value.providers.codex.apiKeyEnv = `ROTATED_REF_${i}`;
      const refused = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: 'Bearer deliberately-wrong' } });
      assert.equal(refused.status, 401); // Rejected locally, never forwarded upstream.
      assert.equal(f.events.filter(e => e[0] === 'credential').at(-1)[1], `ROTATED_REF_${i}`);
      assert.equal((await f.controller.setMode('headers')).phase, 'ready');
      assert.equal(f.controller.server, undefined);
      assert.equal(f.documents[0].value.providers.codex.baseURL, upstream);
    }
  } finally { await f.controller.dispose(); }
});
