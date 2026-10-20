import test from 'node:test';
import assert from 'node:assert/strict';
import { createAjoApiHandler } from './ajo-api-handler.mjs';
import { NEAR_WALLET_CHALLENGE_PATH, NEAR_WALLET_VERIFY_PATH } from './near-wallet-auth-handler.mjs';
import { MEMBER_QUOTE_ENDPOINT_PATH } from './member-quote-handler.mjs';
import { startMemberQuoteDevServer } from './member-quote-dev-server.mjs';

async function withServer(handler, callback) {
  const server = await startMemberQuoteDevServer({ handler });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('composes wallet auth and member quote routes without passing requests to the wrong handler', async () => {
  const calls = [];
  const handler = createAjoApiHandler({
    authHandler: async (request, response) => { calls.push('auth'); response.statusCode = 200; response.end('auth'); },
    memberQuoteHandler: async (request, response) => { calls.push('quote'); response.statusCode = 201; response.end('quote'); },
    fallbackHandler: async (request, response) => { calls.push('fallback'); response.statusCode = 202; response.end('fallback'); },
  });
  await withServer(handler, async base => {
    assert.equal((await fetch(base + NEAR_WALLET_CHALLENGE_PATH, { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + NEAR_WALLET_VERIFY_PATH, { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + MEMBER_QUOTE_ENDPOINT_PATH, { method: 'POST' })).status, 201);
    assert.equal((await fetch(base + '/api/status', { method: 'GET' })).status, 202);
    assert.deepEqual(calls, ['auth', 'auth', 'quote', 'fallback']);
  });
});

test('requires concrete handlers and safely answers unknown routes without fallback', async () => {
  assert.throws(() => createAjoApiHandler(), /auth handler is required/);
  const handler = createAjoApiHandler({ authHandler: async () => {}, memberQuoteHandler: async () => {} });
  await withServer(handler, async base => {
    const response = await fetch(base + '/not-found');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
  });
});
