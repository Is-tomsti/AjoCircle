import test from 'node:test';
import assert from 'node:assert/strict';
import { createAjoApiHandler } from './ajo-api-handler.mjs';
import { NEAR_WALLET_CHALLENGE_PATH, NEAR_WALLET_VERIFY_PATH } from './near-wallet-auth-handler.mjs';
import { MEMBER_QUOTE_ENDPOINT_PATH, MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH } from './member-quote-handler.mjs';
import { NEAR_REFUND_WALLET_VERIFY_PATH } from './near-refund-wallet-verification-handler.mjs';
import { CONTRIBUTION_STATUS_ENDPOINT_PATH } from './contribution-status-handler.mjs';
import { CIRCLE_ASSET_CATALOG_PATH } from './circle-asset-config-handler.mjs';
import { CIRCLE_CREATE_PATH, CIRCLE_CONTRACT_VERIFY_PATH, CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, CIRCLE_POLICY_PREVIEW_PATH, CIRCLE_JOIN_PATH, CIRCLE_INVITATION_PATH, CIRCLE_INVITATION_REVOKE_PATH, CIRCLE_CYCLE_STATUS_PATH, CIRCLE_CYCLE_CONFIGURE_PATH, CIRCLE_CYCLE_START_PATH } from './circle-policy-handler.mjs';
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
    assert.equal((await fetch(base + MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH, { method: 'POST' })).status, 201);
    assert.equal((await fetch(base + '/api/status', { method: 'GET' })).status, 202);
    assert.deepEqual(calls, ['auth', 'auth', 'quote', 'quote', 'fallback']);
  });
});

test('dispatches contribution-status requests only to the dedicated status handler', async () => {
  let statusCalls = 0;
  const handler = createAjoApiHandler({
    authHandler: async () => {},
    memberQuoteHandler: async () => {},
    contributionStatusHandler: async (request, response) => { statusCalls += 1; response.statusCode = 200; response.end('status'); },
    fallbackHandler: async (request, response) => { response.statusCode = 202; response.end('fallback'); },
  });
  await withServer(handler, async base => {
    assert.equal((await fetch(base + CONTRIBUTION_STATUS_ENDPOINT_PATH, { method: 'GET' })).status, 200);
    assert.equal((await fetch(base + '/api/other', { method: 'GET' })).status, 202);
    assert.equal(statusCalls, 1);
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

test('dispatches policy preview, join, and invitation routes to the circle policy handler', async () => {
  const calls = [];
  const handler = createAjoApiHandler({
    authHandler: async (request, response) => { response.statusCode = 200; response.end('auth'); },
    memberQuoteHandler: async (request, response) => { response.statusCode = 201; response.end('quote'); },
    circlePolicyHandler: async (request, response) => { calls.push(new URL(request.url, 'http://localhost').pathname); response.statusCode = 200; response.end('policy'); },
    fallbackHandler: async (request, response) => { response.statusCode = 202; response.end('fallback'); },
  });
  await withServer(handler, async base => {
    for (const path of [CIRCLE_CREATE_PATH, CIRCLE_CONTRACT_VERIFY_PATH, CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, CIRCLE_POLICY_PREVIEW_PATH, CIRCLE_JOIN_PATH, CIRCLE_INVITATION_PATH, CIRCLE_INVITATION_REVOKE_PATH, CIRCLE_CYCLE_STATUS_PATH, CIRCLE_CYCLE_CONFIGURE_PATH, CIRCLE_CYCLE_START_PATH]) {
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 200);
    }
    assert.deepEqual(calls, [CIRCLE_CREATE_PATH, CIRCLE_CONTRACT_VERIFY_PATH, CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, CIRCLE_POLICY_PREVIEW_PATH, CIRCLE_JOIN_PATH, CIRCLE_INVITATION_PATH, CIRCLE_INVITATION_REVOKE_PATH, CIRCLE_CYCLE_STATUS_PATH, CIRCLE_CYCLE_CONFIGURE_PATH, CIRCLE_CYCLE_START_PATH]);
  });
});


test('dispatches the public distribution assessment route without invoking transaction handlers', async () => {
  const { PUBLIC_DISTRIBUTION_ASSESSMENT_PATH } = await import('./public-distribution-assessment-handler.mjs');
  let called = false;
  const noop = async (_request, response) => { response.statusCode = 204; response.end(); };
  const api = createAjoApiHandler({
    authHandler: noop,
    memberQuoteHandler: noop,
    publicDistributionAssessmentHandler: async (_request, response) => {
      called = true;
      response.statusCode = 200;
      response.end(JSON.stringify({ transactionSubmitted: false }));
    },
  });
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
  await api({ method: 'POST', url: PUBLIC_DISTRIBUTION_ASSESSMENT_PATH, headers: {} }, response);
  assert.equal(called, true);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).transactionSubmitted, false);
});


test('dispatches public distribution execution to its dedicated guarded handler', async () => {
  const { PUBLIC_DISTRIBUTION_EXECUTION_PATH } = await import('./public-distribution-execution-handler.mjs');
  let called = false;
  const noop = async (_request, response) => { response.statusCode = 204; response.end(); };
  const api = createAjoApiHandler({
    authHandler: noop,
    memberQuoteHandler: noop,
    publicDistributionExecutionHandler: async (_request, response) => {
      called = true; response.statusCode = 200; response.end(JSON.stringify({ transactionSubmitted: false }));
    },
  });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  await api({ method: 'POST', url: PUBLIC_DISTRIBUTION_EXECUTION_PATH, headers: {} }, response);
  assert.equal(called, true);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).transactionSubmitted, false);
});


test('dispatches the approved asset catalogue route to the dedicated asset handler', async () => {
  let calls = 0;
  const handler = createAjoApiHandler({
    authHandler: async (_request, response) => { response.statusCode = 204; response.end(); },
    memberQuoteHandler: async (_request, response) => { response.statusCode = 204; response.end(); },
    circleAssetConfigHandler: async (request, response) => {
      calls += 1;
      assert.equal(new URL(request.url, 'http://localhost').pathname, CIRCLE_ASSET_CATALOG_PATH);
      response.statusCode = 200;
      response.end(JSON.stringify({ assets: [], configured: false, liveSettlementEnabled: false }));
    },
    fallbackHandler: async (_request, response) => { response.statusCode = 202; response.end('fallback'); },
  });
  await withServer(handler, async base => {
    const response = await fetch(base + CIRCLE_ASSET_CATALOG_PATH, { method: 'GET' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { assets: [], configured: false, liveSettlementEnabled: false });
    assert.equal(calls, 1);
  });
});


test('dispatches NEAR refund-wallet verification to its dedicated authenticated handler', async () => {
  let calls = 0;
  const noop = async (_request, response) => { response.statusCode = 204; response.end(); };
  const handler = createAjoApiHandler({
    authHandler: noop,
    memberQuoteHandler: noop,
    nearRefundWalletVerificationHandler: async (_request, response) => {
      calls += 1;
      response.statusCode = 200;
      response.end(JSON.stringify({ verification: { verificationStatus: 'VERIFIED' } }));
    },
  });

  await withServer(handler, async base => {
    const response = await fetch(base + NEAR_REFUND_WALLET_VERIFY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ circleId: 'circle-1', assetId: 'nep141:token.near', address: 'alice.near' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      verification: { verificationStatus: 'VERIFIED' }
    });
    assert.equal(calls, 1);
  });
});