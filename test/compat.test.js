import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { addCompatibilityHeaders, createCompatibilityServer, matchesRequest, prepareConfig } from '../compat.js';

async function fixture(t, handler, extra = {}, dependencies = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let currentKey = 'test-key';
  let requests = 0;
  const config = { upstreamBaseURL: 'https://gateway.example/coding/v1', ...extra };
  const proxy = createCompatibilityServer(config, {
    resolveKey: async () => currentKey,
    ...dependencies,
    request: (options, callback) => {
      requests++;
      return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: upstream.address().port }, callback);
    },
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { await proxy.stop(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); });
  const port = proxy.address().port;
  function call(path, { method = 'POST', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${currentKey}`, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { call, port, proxy, get requests() { return requests; }, setKey(value) { currentKey = value; } };
}

test('header mode scopes by normalized base URL and optional provider, never sets User-Agent', () => {
  const config = prepareConfig({ providerIds: ['coding'] });
  assert(matchesRequest({ provider: 'coding', baseURL: 'https://api.tu-zi.com/coding/v1/' }, config));
  for (const request of [
    { provider: 'other', baseURL: config.upstreamBaseURL },
    { provider: 'coding', baseURL: 'https://api.tu-zi.com/coding/v1/other' },
    { provider: 'coding', baseURL: 'https://api.tu-zi.com.evil.example/coding/v1' },
  ]) assert(!matchesRequest(request, config));
  const headers = new Headers({ 'user-agent': 'deepseek-harness/test', authorization: 'Bearer test' });
  addCompatibilityHeaders(headers, config);
  assert.equal(headers.get('originator'), 'codex_cli_rs');
  assert.equal(headers.get('x-codex-window-id'), config.windowId);
  assert.equal(headers.get('user-agent'), 'deepseek-harness/test');
  assert.equal(headers.get('authorization'), 'Bearer test');
});

test('configuration rejects insecure upstream, invalid port, UUID and header injection', () => {
  for (const source of [
    { upstreamBaseURL: 'http://example.com/v1' }, { upstreamBaseURL: 'https://u:p@example.com/v1' },
    { upstreamBaseURL: 'https://example.com/v1?q=x' }, { port: 1.5 }, { port: 70000 },
    { windowId: 'not-a-uuid' }, { originator: 'codex\r\nx: y' }, { idleTimeoutMs: 0 },
  ]) assert.throws(() => prepareConfig(source));
});

test('proxy preserves JSON/tool fields and overrides only transport/client identity headers', async t => {
  const body = JSON.stringify({ model: 'test', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], input: [{ type: 'function_call_output', call_id: 'abc', output: '你好' }], stream: true });
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/coding/v1/responses');
    assert.equal(req.headers.host, 'gateway.example');
    assert.equal(req.headers['user-agent'], 'codex_cli_rs/0.167.0');
    assert.equal(req.headers.originator, 'codex_cli_rs');
    assert.match(req.headers['x-codex-window-id'], /^[0-9a-f-]{36}$/);
    assert.equal(req.headers.session_id, 'request-123');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    for (const name of ['cookie', 'referer', 'x-forwarded-for', 'x-forwarded-port', 'x-drop']) assert.equal(req.headers[name], undefined);
    let received = ''; for await (const chunk of req) received += chunk;
    assert.equal(received, body);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private=1', connection: 'x-response-drop', 'x-response-drop': 'no' });
    res.end('{"ok":true}');
  });
  const result = await f.call('/v1/responses', { body, headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    'user-agent': 'deepseek-harness/test', originator: 'other', 'x-client-request-id': 'request-123',
    cookie: 'secret=1', referer: 'private', 'x-forwarded-for': 'private', 'x-forwarded-port': '12',
    connection: 'x-drop', 'x-drop': 'no',
  } });
  assert.equal(result.status, 200); assert.equal(result.body, '{"ok":true}');
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['x-response-drop'], undefined);
});

test('Host, Origin, routes and credential failures make no upstream request', async t => {
  const f = await fixture(t, () => assert.fail('unexpected upstream request'));
  assert.equal((await f.call('/health', { method: 'GET' })).status, 200);
  assert.equal((await f.call('/v1/responses', { headers: { host: 'localhost:123' } })).status, 403);
  assert.equal((await f.call('/v1/responses', { headers: { origin: '' } })).status, 403);
  assert.equal((await f.call('/v1/responses?target=https://evil.example')).status, 404);
  assert.equal((await f.call('/v1/unknown')).status, 404);
  assert.equal((await f.call('/v1/responses', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  f.setKey(undefined);
  assert.equal((await f.call('/v1/responses')).status, 503);
  assert.equal(f.requests, 0);
});

test('allowed routes map exactly and credentials rotate without restart', async t => {
  const seen = [];
  const f = await fixture(t, (req, res) => { seen.push([req.method, req.url, req.headers.authorization]); req.resume(); res.end('ok'); });
  await f.call('/v1/models', { method: 'GET' });
  await f.call('/v1/responses/compact');
  f.setKey('rotated-key'); await f.call('/v1/chat/completions');
  assert.deepEqual(seen, [
    ['GET', '/coding/v1/models', 'Bearer test-key'],
    ['POST', '/coding/v1/responses/compact', 'Bearer test-key'],
    ['POST', '/coding/v1/chat/completions', 'Bearer rotated-key'],
  ]);
});

test('SSE arrives before completion and unfinished stream gets no fabricated finish event', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = 'event: response.output_text.delta\ndata: {"delta":"你好"}\n\n';
  const last = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const f = await fixture(t, async (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(first);
    await hold; res.end(last);
  });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer test-key' } }, res => {
      let body = ''; let released = false;
      res.on('data', chunk => { body += chunk; if (!released) { assert.equal(body, first); released = true; release(); } });
      res.on('error', reject);
      res.on('end', () => { assert.equal(body, first + last); resolve(); });
    });
    req.on('error', reject); req.end();
  });
  const incomplete = await fixture(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(first); });
  assert.equal((await incomplete.call('/v1/responses')).body, first);
});

test('upstream errors pass through and redirects never follow', async t => {
  const f = await fixture(t, (req, res) => {
    req.resume();
    if (req.url.endsWith('/compact')) { res.writeHead(307, { location: 'https://elsewhere.example' }); res.end(); }
    else { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":{"code":"codex_cli_only"}}'); }
  });
  const denied = await f.call('/v1/responses');
  assert.equal(denied.status, 403); assert.equal(denied.body, '{"error":{"code":"codex_cli_only"}}');
  assert.equal((await f.call('/v1/responses/compact')).status, 502);
  assert.equal(f.requests, 2);
});

test('client cancellation tears down upstream streaming response', async t => {
  let closed;
  const ended = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (req, res) => { req.resume(); res.on('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n'); });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer test-key' } }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.on('error', reject); req.end();
  });
  await ended;
});

test('credential wait has a deadline and late results cannot forward', async t => {
  let release;
  const credentials = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => assert.fail('late upstream request'), { idleTimeoutMs: 30 }, { resolveKey: () => credentials });
  assert.equal((await f.call('/v1/responses')).status, 503);
  release('test-key');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests, 0);
});

test('disconnect and stop cancel pending credential waits before late resolution', async t => {
  for (const action of ['disconnect', 'stop']) {
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const credentials = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, () => assert.fail('cancelled upstream request'), {}, { resolveKey: () => { entered(); return credentials; } });
    const downstreamClosed = new Promise(resolve => f.proxy.once('connection', socket => socket.once('close', resolve)));
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer test-key' } });
    req.on('error', () => {});
    const closed = once(req, 'close');
    req.end(); await waiting;
    if (action === 'disconnect') req.destroy(); else await f.proxy.stop();
    await closed.catch(error => { assert.equal(error.code, 'ECONNRESET'); });
    await downstreamClosed;
    release('test-key'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests, 0);
  }
});

test('active SSE is aborted on stop or upstream truncation without fabricated completion', async t => {
  const delta = 'data: {"delta":"partial"}\n\n';
  for (const action of ['stop', 'truncate']) {
    let remote;
    let closed;
    const ended = new Promise(resolve => { closed = resolve; });
    const f = await fixture(t, (req, res) => {
      req.resume(); remote = res; res.on('close', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(delta);
    });
    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer test-key' } }, res => {
        let received = '';
        res.on('data', chunk => {
          received += chunk;
          if (action === 'stop') void f.proxy.stop(); else remote.destroy();
        });
        res.on('error', () => {});
        res.on('close', () => { assert.equal(received, delta); assert.equal(res.complete, false); resolve(); });
      });
      req.on('error', reject); req.end();
    });
    await ended;
  }
});

test('header wait timeout returns 502 and stop releases the listening port', async t => {
  const f = await fixture(t, req => req.resume(), { idleTimeoutMs: 50 });
  assert.equal((await f.call('/v1/responses')).status, 502);
  await f.proxy.stop();
  const replacement = http.createServer();
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(f.port, '127.0.0.1', resolve); });
  await new Promise(resolve => replacement.close(resolve));
});
