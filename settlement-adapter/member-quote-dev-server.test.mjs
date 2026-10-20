import test from 'node:test';
import assert from 'node:assert/strict';
import { startMemberQuoteDevServer } from './member-quote-dev-server.mjs';

test('development server binds only to loopback and forwards real HTTP requests to the configured handler', async () => {
  const seen = [];
  const server = await startMemberQuoteDevServer({
    handler: async (request, response) => {
      seen.push({ method: request.method, url: request.url });
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    },
  });
  try {
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/member/quote`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(seen, [{ method: 'POST', url: '/api/member/quote' }]);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('development server fails closed when no configured handler is provided', async () => {
  await assert.rejects(() => startMemberQuoteDevServer(), /configured member quote handler/);
});

test('development server rejects invalid ports before listening', async () => {
  await assert.rejects(() => startMemberQuoteDevServer({ handler() {}, port: 65536 }), /port must be an integer/);
});

test('unexpected handler exceptions return a generic no-store error without leaking details', async () => {
  const server = await startMemberQuoteDevServer({ handler: async () => { throw new Error('private secret detail'); } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { error: 'INTERNAL_ERROR' });
    assert.equal(JSON.stringify(body).includes('private secret detail'), false);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
