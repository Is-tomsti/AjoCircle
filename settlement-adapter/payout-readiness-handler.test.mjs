import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayoutReadinessHandler, PAYOUT_READINESS_PATH } from './payout-readiness-handler.mjs';

function responseDouble() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body = '') { this.body = body; }, json() { return JSON.parse(this.body); } };
}
function req(body, subject = 'member.near', method = 'POST') {
  return { url: PAYOUT_READINESS_PATH, method, body, subject, headers: { authorization: 'Bearer test' } };
}
function setup({ membership = { status: 'ACTIVE' }, binding = null, parity = null, auth = async request => request.subject ? { subject: request.subject } : null } = {}) {
  const calls = [];
  const store = {
    findMembershipForPrincipal: args => { calls.push(['membership', args]); return membership; },
    getVerifiedContractBinding: args => { calls.push(['binding', args]); return binding; },
    getCircleScheduleParityContext: args => { calls.push(['parity', args]); return parity; },
  };
  const handler = createPayoutReadinessHandler({ store, authenticateRequest: auth });
  return { handler, calls };
}
async function call(handler, request) { const response = responseDouble(); await handler(request, response); return response; }

test('requires authentication before looking up circle state', async () => {
  const { handler, calls } = setup();
  const response = await call(handler, req({ circleId: 'circle-one' }, null));
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'UNAUTHENTICATED');
  assert.equal(calls.length, 0);
});

test('rejects wrong method and malformed request fields', async () => {
  const { handler } = setup();
  assert.equal((await call(handler, req({ circleId: 'circle-one' }, 'member.near', 'GET'))).statusCode, 405);
  assert.equal((await call(handler, req({ circleId: 'circle-one', contractId: 'forged.testnet' }))).statusCode, 400);
});

test('requires active membership before reading contract binding', async () => {
  const { handler, calls } = setup({ membership: null });
  const response = await call(handler, req({ circleId: 'circle-one' }));
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'ACTIVE_MEMBERSHIP_REQUIRED');
  assert.equal(calls.some(([name]) => name === 'binding'), false);
});

test('fails closed when no verified binding and local schedule exist', async () => {
  const { handler } = setup();
  const response = await call(handler, req({ circleId: 'circle-one' }));
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'PAYOUT_READINESS_NOT_VERIFIED');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('rejects non-testnet RPC configuration', () => {
  assert.throws(() => createPayoutReadinessHandler({
    store: { findMembershipForPrincipal() {}, getVerifiedContractBinding() {}, getCircleScheduleParityContext() {} },
    authenticateRequest: async () => ({ subject: 'member.near' }),
    rpcUrl: 'https://rpc.mainnet.near.org',
  }), /testnet-only/);
});
