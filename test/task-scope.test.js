import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTaskScope } from '../task-scope.js';

for (const [bind, hostname] of [['127.0.0.1', '127.0.0.1'], ['127.0.0.1', 'localhost'], ['::1', '[::1]'], ['::1', 'localhost']]) {
  test(`neutral task scope reaches ${bind} via ${hostname}`, async t => {
    const routes = new Map();
    const carrier = http.createServer((req, res) => {
      const route = routes.get(req.url);
      if (route) route(req, res);
      else { res.writeHead(404); res.end(); }
    });
    carrier.listen({ host: bind, port: 0, ipv6Only: bind === '::1' });
    try { await once(carrier, 'listening'); }
    catch (error) {
      if (bind === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.skip('Runner has no IPv6 loopback'); return; }
      throw error;
    }
    const transaction = new AsyncLocalStorage();
    const scope = transaction.run(true, () => createTaskScope({
      getOrigin: () => `http://${hostname}:${carrier.address().port}`,
      register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
    }));
    try {
      assert.equal(await transaction.run(true, () => scope.run(() => transaction.getStore())), undefined);
      assert.equal(routes.size, 0, 'one-shot route was removed');
    } finally {
      scope.close();
      await new Promise(resolve => { carrier.close(resolve); carrier.closeAllConnections(); });
    }
  });
}

test('loopback connection failure retains its diagnostic code and removes the temporary route', async () => {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const routes = new Map();
  const scope = createTaskScope({
    getOrigin: () => `http://127.0.0.1:${port}`,
    register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
  });
  try {
    await assert.rejects(scope.run(() => assert.fail('failed scope executed')), /ECONNREFUSED/);
    assert.equal(routes.size, 0);
  } finally { scope.close(); }
});
