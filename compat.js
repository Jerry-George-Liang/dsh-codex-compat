import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';

export const defaults = Object.freeze({
  mode: 'headers', upstreamBaseURL: 'https://api.tu-zi.com/coding/v1',
  providerIds: [], port: 3081, credentialRef: 'TUZI_CODING_API_KEY',
  originator: 'codex_cli_rs', windowId: '',
  userAgent: 'codex_cli_rs/0.167.0', idleTimeoutMs: 300_000,
});
const routes = new Map([
  ['GET /v1/models', '/models'],
  ['POST /v1/responses', '/responses'],
  ['POST /v1/responses/compact', '/responses/compact'],
  ['POST /v1/chat/completions', '/chat/completions'],
]);
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const privateHeaders = ['cookie', 'origin', 'referer', 'forwarded'];

export function normalizeBaseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('upstreamBaseURL must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('upstreamBaseURL must use HTTPS without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

export function prepareConfig(source = {}) {
  const config = { ...defaults, ...source };
  config.upstreamBaseURL = normalizeBaseURL(config.upstreamBaseURL);
  if (!['off', 'headers', 'proxy'].includes(config.mode)) throw new Error('Invalid compatibility mode');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('port must be between 1 and 65535');
  if (!Number.isInteger(config.idleTimeoutMs) || config.idleTimeoutMs < 1 || config.idleTimeoutMs > 2147483647) throw new Error('Invalid idleTimeoutMs');
  if (!Array.isArray(config.providerIds) || config.providerIds.some(x => typeof x !== 'string' || !x.trim())) throw new Error('providerIds must contain provider IDs');
  if (typeof config.credentialRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialRef)) throw new Error('credentialRef must name a credential reference');
  for (const name of ['originator', 'userAgent']) {
    if (typeof config[name] !== 'string' || !config[name].trim()) throw new Error(`${name} must not be empty`);
    try { http.validateHeaderValue(name, config[name]); } catch { throw new Error(`Invalid ${name} header value`); }
  }
  if (config.windowId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.windowId)) throw new Error('windowId must be a UUID or empty');
  config.windowId ||= randomUUID();
  return config;
}

export function matchesRequest(request, config) {
  if (config.providerIds.length && !config.providerIds.includes(request.provider)) return false;
  try { return normalizeBaseURL(request.baseURL) === config.upstreamBaseURL; } catch { return false; }
}

export function addCompatibilityHeaders(headers, config) {
  headers.set('originator', config.originator);
  headers.set('x-codex-window-id', config.windowId);
}

export function transportHeaders(source) {
  const result = { ...source };
  const nominated = String(source.connection ?? '').split(',').map(x => x.trim().toLowerCase());
  for (const key of [...hopHeaders, ...nominated]) delete result[key];
  return result;
}
function digest(value) { return createHash('sha256').update(value).digest(); }
// The credential API has no AbortSignal; bound our wait and release transport listeners.
function resolveCredential(resolveKey, config, incoming, outgoing) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, key) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      incoming.off('aborted', cancelled);
      outgoing.off('close', cancelled);
      if (error) reject(error); else resolve(key);
    };
    const cancelled = () => finish(new Error('Credential wait cancelled'));
    const timer = setTimeout(() => finish(new Error('Credential wait timed out')), config.idleTimeoutMs);
    timer.unref?.();
    incoming.once('aborted', cancelled);
    outgoing.once('close', cancelled);
    if (incoming.aborted || outgoing.destroyed) { cancelled(); return; }
    Promise.resolve().then(() => resolveKey(config.credentialRef)).then(
      key => finish(undefined, key), error => finish(error),
    );
  });
}
function reject(response, status, message) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { type: 'local_proxy_error', message } }));
}

/** The destination is fixed at construction; request injection is for keyless local tests. */
export function createCompatibilityServer(source, { resolveKey, request = https.request, log = () => {} }) {
  const config = prepareConfig(source);
  const destination = new URL(config.upstreamBaseURL);
  const active = new Set();
  let stopping = false;
  const server = http.createServer((incoming, outgoing) => {
    void handle(incoming, outgoing).catch(() => {
      if (!outgoing.headersSent) reject(outgoing, 502, 'Local proxy request failed');
      else outgoing.destroy();
      incoming.resume();
    });
  });
  async function handle(incoming, outgoing) {
    const localPort = server.address()?.port;
    if (stopping || incoming.headers.host !== `127.0.0.1:${localPort}` || incoming.headers.origin !== undefined) {
      reject(outgoing, 403, 'Only local server requests are accepted'); incoming.resume(); return;
    }
    if (incoming.method === 'GET' && incoming.url === '/health') {
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify({ status: 'ready', mode: 'proxy', baseURL: `http://127.0.0.1:${localPort}/v1` })); return;
    }
    const suffix = routes.get(`${incoming.method} ${incoming.url}`);
    if (!suffix) { reject(outgoing, 404, 'Unsupported API route'); incoming.resume(); return; }
    let key;
    try { key = await resolveCredential(resolveKey, config, incoming, outgoing); } catch { /* never expose credential-service errors */ }
    if (stopping || incoming.aborted || outgoing.destroyed) { incoming.resume(); return; }
    if (typeof key !== 'string' || !key.trim()) { reject(outgoing, 503, 'Configured credential is unavailable'); incoming.resume(); return; }
    const auth = incoming.headers.authorization;
    if (typeof auth !== 'string' || !timingSafeEqual(digest(auth), digest(`Bearer ${key}`))) {
      reject(outgoing, 401, 'Use the configured provider credential'); incoming.resume(); return;
    }
    const headers = transportHeaders(incoming.headers);
    for (const name of Object.keys(headers)) {
      if (privateHeaders.includes(name) || name.startsWith('x-forwarded-')) delete headers[name];
    }
    Object.assign(headers, { host: destination.host, authorization: `Bearer ${key}`,
      'user-agent': config.userAgent, originator: config.originator, 'x-codex-window-id': config.windowId });
    if (!headers.session_id) headers.session_id = headers['x-client-request-id'] || randomUUID();
    const started = Date.now();
    let connectTimer;
    const upstream = request({ protocol: 'https:', hostname: destination.hostname, port: destination.port || 443,
      path: `${destination.pathname.replace(/\/$/, '')}${suffix}`, method: incoming.method, headers }, response => {
      clearTimeout(connectTimer);
      if (outgoing.destroyed) { response.destroy(); return; }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy(); reject(outgoing, 502, 'Upstream redirects are not supported'); return;
      }
      const returned = transportHeaders(response.headers);
      delete returned['set-cookie'];
      outgoing.writeHead(response.statusCode ?? 502, returned);
      outgoing.flushHeaders();
      // Deliberately omit headers, credentials, bodies, query strings and error messages.
      log({ method: incoming.method, route: incoming.url, status: response.statusCode, headerLatencyMs: Date.now() - started });
      pipeline(response, outgoing, () => {});
    });
    active.add(upstream);
    // Covers DNS/connect/TLS/header waits as well as socket inactivity.
    connectTimer = setTimeout(() => upstream.destroy(new Error('Upstream header timeout')), config.idleTimeoutMs);
    connectTimer.unref?.();
    upstream.setTimeout(config.idleTimeoutMs, () => upstream.destroy(new Error('Upstream idle timeout')));
    upstream.on('close', () => { clearTimeout(connectTimer); active.delete(upstream); });
    upstream.on('error', () => {
      clearTimeout(connectTimer);
      log({ method: incoming.method, route: incoming.url, status: 'upstream_transport_error' });
      if (!outgoing.headersSent) reject(outgoing, 502, 'Upstream transport failed'); else outgoing.destroy();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => { if (!outgoing.writableFinished) upstream.destroy(); });
    pipeline(incoming, upstream, error => { if (error) upstream.destroy(); });
  }
  server.headersTimeout = 15_000;
  server.requestTimeout = config.idleTimeoutMs;
  server.stop = () => new Promise(resolve => {
    stopping = true;
    for (const upstream of active) upstream.destroy();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return server;
}
