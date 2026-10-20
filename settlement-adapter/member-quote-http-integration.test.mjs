import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationStore } from './application-store.mjs';
import { createApplicationContextResolvers } from './application-context-adapter.mjs';
import { SettlementStore } from './settlement-store.mjs';
import { createMemberQuoteHandler, MEMBER_QUOTE_ENDPOINT_PATH } from './member-quote-handler.mjs';
import { startMemberQuoteDevServer } from './member-quote-dev-server.mjs';

const validBody = {
  circleId: 'circle-http', round: 1, originAsset: 'asset:test-usdc', amount: '2000000',
};

function createFixture({ authenticated = true } = {}) {
  const applicationStore = new ApplicationStore();
  const settlementStore = new SettlementStore();
  applicationStore.upsertCircle({ circleId: 'circle-http', contractId: 'circle-http.near' });
  applicationStore.upsertMember({ memberId: 'member-http', principalId: 'test-subject-001', nearAccount: 'member-http.near' });
  applicationStore.setMembership({ circleId: 'circle-http', memberId: 'member-http' });
  applicationStore.setRound({ circleId: 'circle-http', round: 1, contributionAmount: '1000000000000000000000000', deadlineMs: 1900000000000 });
  applicationStore.setCircleAsset({ circleId: 'circle-http', assetId: 'asset:test-usdc', maxInputAmount: '5000000' });
  applicationStore.setRefundAddress({ memberId: 'member-http', assetId: 'asset:test-usdc', address: '0xregistered-http-refund' });

  const resolvers = createApplicationContextResolvers({
    repository: applicationStore,
    // Test-only identity extraction. This is not a production authentication provider.
    getPrincipalId: principal => principal.subject,
  });
  const quoteRequests = [];
  const handler = createMemberQuoteHandler({
    store: settlementStore,
    quoteClient: {
      async getQuote(request) {
        quoteRequests.push(request);
        return {
          depositAddress: 'provider-http-deposit',
          originAsset: request.originAsset,
          destinationAsset: request.destinationAsset,
          recipient: request.recipient,
          amountIn: request.amount,
          amountOut: '1100000000000000000000000',
          minimumAmountOut: '1050000000000000000000000',
          deadline: '2030-01-01T00:00:00.000Z',
        };
      },
    },
    authenticateRequest: async request => {
      if (!authenticated || request.headers.authorization !== 'Bearer test-only-session') return null;
      return { subject: 'test-subject-001' };
    },
    ...resolvers,
    clock: () => new Date('2026-10-20T21:00:00.000Z'),
    idFactory: () => 'http-integration-intent',
  });
  return { applicationStore, settlementStore, quoteRequests, handler };
}

async function withServer(fixture, callback) {
  const server = await startMemberQuoteDevServer({ handler: fixture.handler });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fixture.applicationStore.close();
    fixture.settlementStore.close();
  }
}

test('real HTTP request authenticates, resolves SQLite membership/context, and persists a trusted pending intent', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(baseUrl + MEMBER_QUOTE_ENDPOINT_PATH, {
      method: 'POST', headers: { authorization: 'Bearer test-only-session', 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.quote.memberId, 'member-http');
    assert.equal(body.quote.recipient, 'member-http.near');
    assert.equal(fixture.quoteRequests.length, 1);
    assert.equal(fixture.quoteRequests[0].refundTo, '0xregistered-http-refund');
    assert.equal(fixture.quoteRequests[0].destinationAsset, 'nep141:wrap.near');
    const saved = fixture.settlementStore.getIntent('http-integration-intent');
    assert.equal(saved.status, 'PENDING');
    assert.equal(saved.memberId, 'member-http');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('real HTTP request without a verified session is rejected before quote creation', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(baseUrl + MEMBER_QUOTE_ENDPOINT_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(fixture.quoteRequests.length, 0);
    assert.equal(fixture.settlementStore.getIntent('http-integration-intent'), null);
  });
});

test('real HTTP request rejects a valid test session that has no circle membership', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(baseUrl + MEMBER_QUOTE_ENDPOINT_PATH, {
      method: 'POST', headers: { authorization: 'Bearer test-only-session', 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, circleId: 'circle-not-joined' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'MEMBERSHIP_REQUIRED' });
    assert.equal(fixture.quoteRequests.length, 0);
    assert.equal(fixture.settlementStore.getIntent('http-integration-intent'), null);
  });
});

test('real HTTP request rejects client-supplied member identity fields', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(baseUrl + MEMBER_QUOTE_ENDPOINT_PATH, {
      method: 'POST', headers: { authorization: 'Bearer test-only-session', 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, memberId: 'attacker', refundTo: '0xattacker' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'UNSUPPORTED_FIELD' });
    assert.equal(fixture.quoteRequests.length, 0);
  });
});
