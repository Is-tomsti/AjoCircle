import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationStore } from './application-store.mjs';
import { createApplicationContextResolvers } from './application-context-adapter.mjs';
import { SettlementStore } from './settlement-store.mjs';
import { createMemberQuoteHandler, MEMBER_QUOTE_ENDPOINT_PATH } from './member-quote-handler.mjs';

function seedApplication(store) {
  store.upsertCircle({ circleId: 'circle-integration', contractId: 'circle-contract.near' });
  store.upsertMember({
    memberId: 'member-integration', principalId: 'provider-user-123', nearAccount: 'member.near',
  });
  store.setMembership({ circleId: 'circle-integration', memberId: 'member-integration' });
  store.setRound({
    circleId: 'circle-integration', round: 4, status: 'OPEN',
    contributionAmount: '1000000000000000000000000', deadlineMs: 1900000000000,
  });
  store.setCircleAsset({
    circleId: 'circle-integration', assetId: 'asset:test-usdc', maxInputAmount: '5000000',
  });
  store.setRefundAddress({
    memberId: 'member-integration', assetId: 'asset:test-usdc', address: '0xregistered-refund',
  });
}

function response() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}

const body = {
  circleId: 'circle-integration', round: 4, originAsset: 'asset:test-usdc', amount: '2000000',
};

function buildIntegration({ authenticateRequest } = {}) {
  const applicationStore = new ApplicationStore();
  const settlementStore = new SettlementStore();
  seedApplication(applicationStore);
  const resolvers = createApplicationContextResolvers({
    repository: applicationStore,
    // Test-only principal fixture. Production must replace this with a verified
    // session/token middleware and the real provider's stable subject identifier.
    getPrincipalId: principal => principal.subject,
  });
  const quoteRequests = [];
  const handler = createMemberQuoteHandler({
    store: settlementStore,
    quoteClient: {
      async getQuote(request) {
        quoteRequests.push(request);
        return {
          depositAddress: 'provider-deposit-test',
          originAsset: request.originAsset,
          destinationAsset: request.destinationAsset,
          recipient: request.recipient,
          amountIn: request.amount,
          amountOut: '1100000000000000000000000',
          minimumAmountOut: '1050000000000000000000000',
          deadline: '2026-10-20T21:15:00.000Z',
        };
      },
    },
    authenticateRequest: authenticateRequest ?? (async request => request.authenticatedPrincipal ?? ({ subject: 'provider-user-123' })),
    ...resolvers,
    clock: () => new Date('2026-10-20T21:00:00.000Z'),
    idFactory: () => 'integration-intent-1',
  });
  return { applicationStore, settlementStore, handler, quoteRequests };
}

test('end-to-end quote path blocks registered but unverified refund addresses before contacting 1Click', async () => {
  const ctx = buildIntegration();
  try {
    const res = response();
    await ctx.handler({ method: 'POST', url: MEMBER_QUOTE_ENDPOINT_PATH, body }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'REFUND_WALLET_NOT_REGISTERED');
    assert.equal(ctx.quoteRequests.length, 0);
    assert.equal(ctx.settlementStore.getIntent('integration-intent-1'), null);
  } finally {
    ctx.applicationStore.close();
    ctx.settlementStore.close();
  }
});

test('end-to-end quote path fails closed for an unknown principal before contacting 1Click', async () => {
  const ctx = buildIntegration();
  try {
    const res = response();
    await ctx.handler({
      method: 'POST', url: MEMBER_QUOTE_ENDPOINT_PATH, body,
      // Deliberately not a member; this is only a test fixture, not real auth.
      authenticatedPrincipal: { subject: 'unknown-provider-user' },
    }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'MEMBERSHIP_REQUIRED');
    assert.equal(ctx.quoteRequests.length, 0);
    assert.equal(ctx.settlementStore.getIntent('integration-intent-1'), null);
  } finally {
    ctx.applicationStore.close();
    ctx.settlementStore.close();
  }
});

test('end-to-end quote path rejects an unauthenticated request before database lookup or quote request', async () => {
  const ctx = buildIntegration({ authenticateRequest: async () => null });
  try {
    const res = response();
    await ctx.handler({ method: 'POST', url: MEMBER_QUOTE_ENDPOINT_PATH, body }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'UNAUTHENTICATED');
    assert.equal(ctx.quoteRequests.length, 0);
    assert.equal(ctx.settlementStore.getIntent('integration-intent-1'), null);
  } finally {
    ctx.applicationStore.close();
    ctx.settlementStore.close();
  }
});
