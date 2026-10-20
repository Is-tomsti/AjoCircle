import test from 'node:test';
import assert from 'node:assert/strict';
import { createContributionStatusHandler, CONTRIBUTION_STATUS_ENDPOINT_PATH } from './contribution-status-handler.mjs';

const intent = Object.freeze({
  intentId: 'intent-123', circleId: 'circle-1', memberId: 'member.testnet', round: 2,
  status: 'VERIFIED_DELIVERY', requiredContributionAmount: '1000000000000000000000000',
});
const store = { getIntent: id => id === intent.intentId ? intent : null };
const contractClient = {
  getRound: async () => 2,
  getContribution: async ({ member }) => member === intent.memberId ? intent.requiredContributionAmount : null,
  isCircleCompleted: async () => false,
  isPayoutPending: async () => false,
  isPayoutComplete: async () => false,
};
function request(method = 'GET', url = `${CONTRIBUTION_STATUS_ENDPOINT_PATH}?intentId=${intent.intentId}`, extra = {}) {
  return { method, url, auth: { memberId: intent.memberId }, ...extra };
}
function response() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}

 test('serves status only after trusted intent authorization', async () => {
  let authorizationCalls = 0;
  const handler = createContributionStatusHandler({ store, contractClient, authorizeIntent: async (req, stored) => {
    authorizationCalls += 1;
    assert.equal(req.auth.memberId, stored.memberId);
    return true;
  } });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.status.contractStatus, 'CONTRIBUTION_CONFIRMED');
  assert.equal(authorizationCalls, 1);
});

test('rejects unauthorized access without reading contract state', async () => {
  let rpcCalls = 0;
  const handler = createContributionStatusHandler({ store, contractClient: { ...contractClient, getRound: async () => { rpcCalls += 1; return 2; } }, authorizeIntent: async () => false });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'FORBIDDEN');
  assert.equal(rpcCalls, 0);
});

test('returns safe client errors for wrong method, route, and invalid intent', async () => {
  const handler = createContributionStatusHandler({ store, contractClient, authorizeIntent: async () => true });
  const wrongMethod = response();
  await handler(request('POST'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET');
  const wrongRoute = response();
  await handler(request('GET', '/unrelated'), wrongRoute);
  assert.equal(wrongRoute.statusCode, 404);
  const invalidId = response();
  await handler(request('GET', `${CONTRIBUTION_STATUS_ENDPOINT_PATH}?intentId=%20`), invalidId);
  assert.equal(invalidId.statusCode, 400);
});

test('does not disclose missing intents or internal RPC/store errors', async () => {
  const handler = createContributionStatusHandler({ store, contractClient: { ...contractClient, getRound: async () => { throw new Error('secret RPC endpoint details'); } }, authorizeIntent: async () => true });
  const missing = response();
  await handler(request('GET', `${CONTRIBUTION_STATUS_ENDPOINT_PATH}?intentId=unknown`), missing);
  assert.equal(missing.statusCode, 404);
  const unavailable = response();
  await handler(request(), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.body, { error: 'STATUS_UNAVAILABLE' });
  assert.equal(JSON.stringify(unavailable.body).includes('secret'), false);
});

test('requires an explicit trusted authorization callback', () => {
  assert.throws(() => createContributionStatusHandler({ store, contractClient }), /authorization callback is required/);
});
