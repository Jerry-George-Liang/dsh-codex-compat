import { AsyncResource } from 'node:async_hooks';
import { randomUUID as scopeNonce } from 'node:crypto';
import { request as scopeHttpRequest } from 'node:http';
import { request as scopeHttpsRequest } from 'node:https';

// Loader notifications inherit HMR's AsyncLocalStorage transaction. A one-shot
// request to the already running Web carrier constructs a neutral async resource;
// no mutation, configuration value, or model credential crosses this endpoint.
export function createTaskScope(webServer) {
  const url = new URL(webServer.getOrigin());
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname)) {
    throw new Error('模式自动切换需要可通过本机回环地址访问的 Web 服务。');
  }
  const bearer = scopeNonce();
  // Preserve localhost so Node can try both IPv6 and IPv4 on Windows.
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (url.hostname === '[::]') url.hostname = '[::1]';
  url.pathname = `/_local-codex-compat-scope/${scopeNonce()}`;
  let scope;
  let request;
  let remove;
  let settled = false;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    remove = webServer.register({ kind: 'exact', path: url.pathname, handler(req, res) {
      if (req.method !== 'POST' || req.url !== url.pathname || req.headers.origin || req.headers.host !== url.host ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          req.headers.authorization !== `Bearer ${bearer}`) {
        req.resume(); res.writeHead(403); res.end(); return;
      }
      req.resume();
      scope = new AsyncResource('codex-compat-mode-tasks');
      settled = true;
      remove();
      res.writeHead(204); res.end();
      resolve(scope);
    } });
    const send = url.protocol === 'https:' ? scopeHttpsRequest : scopeHttpRequest;
    request = send(url, {
      method: 'POST', agent: false, timeout: 10000, autoSelectFamily: true,
      headers: { authorization: `Bearer ${bearer}` },
      // This fixed loopback handshake carries only an ephemeral nonce, and must
      // also work when the user's existing Web carrier has a self-signed cert.
      ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, res => {
      res.resume();
      if (res.statusCode !== 204 && !settled) fail({ code: `HTTP_${res.statusCode}` });
    });
    const fail = error => {
      if (settled) return;
      settled = true; remove();
      const code = /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'CONNECT_FAILED';
      reject(new Error(`插件切换任务初始化失败（${code}）；请检查当前 Web 服务的本机连接。`));
    };
    request.once('error', fail);
    request.once('timeout', () => { fail({ code: 'ETIMEDOUT' }); request.destroy(); });
    request.end();
  });
  // apply() must return without awaiting initialization inside the Loader lock.
  ready.catch(() => {});
  return {
    run: callback => ready.then(resource => resource.runInAsyncScope(callback)),
    close() {
      if (!settled) {
        settled = true; remove(); request?.destroy();
        rejectReady(new Error('插件已停用。'));
      }
      scope?.emitDestroy();
    },
  };
}
