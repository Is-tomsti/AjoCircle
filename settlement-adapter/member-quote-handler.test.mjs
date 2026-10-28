import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementStore } from './settlement-store.mjs';
import { createMemberQuoteHandler, MEMBER_QUOTE_ENDPOINT_PATH, MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH } from './member-quote-handler.mjs';

const trusted = {
  circleId: 'circle-1', memberId: 'member-from-db', round: 2,
  circleStatus: 'ACTIVE', memberStatus: 'ACTIVE', roundStatus: 'OPEN',
  memberNearAccount: 'alice.near', requiredContributionAmount: '1000000000000000000000000',
  allowedOriginAssets: ['asset:usdc-base'],
  refundAddresses: { 'asset:usdc-base': '0xregistered-wallet' },
  maxInputAmounts: { 'asset:usdc-base': '5000000' },
  roundDeadlineMs: 1900000000000,
};
const quote = {
  depositAddress: 'quote-deposit-1', originAsset: 'asset:usdc-base', destinationAsset: 'nep141:wrap.near',
  recipient: 'alice.near', amountIn: '2000000', amountOut: '1100000000000000000000000',
  minimumAmountOut: '1050000000000000000000000', deadline: '2026-10-20T20:40:00.000Z',
};
function response() {
  return { headers: {}, statusCode: 200, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(payload) { this.body = JSON.parse(payload); } };
}
function setup(overrides = {}) {
  const store = new SettlementStore();
  const calls = { auth: 0, identity: 0, context: 0, quote: 0 };
  const handler = createMemberQuoteHandler({
    store,
    quoteClient: { async getQuote(request) { calls.quote++; assert.equal(request.recipient, 'alice.near'); assert.equal(request.refundTo, '0xregistered-wallet'); return quote; } },
    authenticateRequest: async request => { calls.auth++; return request.authenticatedPrincipal ?? { subject: 'session-user-1' }; },
    resolveMemberIdentity: async ({ principal, circleId }) => { calls.identity++; assert.equal(principal.subject, 'session-user-1'); assert.equal(circleId, 'circle-1'); return 'member-from-db'; },
    resolveTrustedContext: async ids => { calls.context++; return { ...trusted, ...ids }; },
    clock: () => new Date('2026-10-20T20:25:00.000Z'), idFactory: () => 'intent-api-1',
    ...overrides,
  });
  return { store, handler, calls };
}
const validBody = { circleId: 'circle-1', round: 2, originAsset: 'asset:usdc-base', amount: '2000000' };
const request = (body = validBody, extra = {}) => ({ method: 'POST', url: MEMBER_QUOTE_ENDPOINT_PATH, body, ...extra });

test('creates quote for authenticated member resolved by server-side identity, not client member or refund fields', async () => {
  const ctx = setup(); const res = response();
  await ctx.handler(request({ ...validBody, memberId: 'attacker', refundTo: '0xattacker' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'UNSUPPORTED_FIELD');
  assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});

test('creates and persists quote using trusted membership and registered refund wallet', async () => {
  const ctx = setup(); const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.quote.intentId, 'intent-api-1');
  assert.equal(ctx.store.getIntent('intent-api-1').memberId, 'member-from-db');
  assert.equal(ctx.calls.auth, 1); assert.equal(ctx.calls.identity, 1); assert.equal(ctx.calls.context, 2); assert.equal(ctx.calls.quote, 1);
  ctx.store.close();
});

test('rechecks lifecycle and blocks provider access if the circle completes between checks', async () => {
  let contextCalls = 0;
  let providerCalls = 0;
  const ctx = setup({
    quoteClient: {
      async getQuote() {
        providerCalls++;
        return quote;
      },
    },
    resolveTrustedContext: async ids => {
      contextCalls++;
      return {
        ...trusted,
        ...ids,
        ...(contextCalls >= 2 ? { circleStatus: 'COMPLETED' } : {}),
      };
    },
  });

  const res = response();
  await ctx.handler(request(), res);

  assert.equal(contextCalls, 2, 'trusted context should be checked again');
  assert.equal(providerCalls, 0, 'completed circle must be blocked before provider access');
  assert.equal(res.statusCode, 422);
  assert.equal(ctx.store.getIntent('intent-api-1'), null);

  ctx.store.close();
});
test('rejects unauthenticated requests before membership lookup or quote creation', async () => {
  const ctx = setup({ authenticateRequest: async () => null }); const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 401); assert.equal(res.body.error, 'UNAUTHENTICATED');
  assert.equal(ctx.calls.identity, 0); assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});

test('rejects missing membership and does not request a quote', async () => {
  const ctx = setup({ resolveMemberIdentity: async () => null }); const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.error, 'MEMBERSHIP_REQUIRED');
  assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});

test('rejects invalid method, route, body, and unregistered refund wallet safely', async () => {
  const ctx = setup();
  let res = response(); await ctx.handler({ ...request(), method: 'GET' }, res);
  assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, 'POST');
  res = response(); await ctx.handler({ ...request(), url: '/bad' }, res); assert.equal(res.statusCode, 404);
  res = response(); await ctx.handler(request({ ...validBody, amount: '0' }), res); assert.equal(res.statusCode, 400);
  res = response(); await ctx.handler(request({ ...validBody, originAsset: 'asset:unknown' }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'REFUND_WALLET_NOT_REGISTERED');
  assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});

test('requires real authentication, member identity, and trusted context callbacks', () => {
  const store = new SettlementStore();
  assert.throws(() => createMemberQuoteHandler({ store }), /quote client is required/);
  store.close();
});


test('requires each authentication and trusted resolver dependency explicitly', () => {
  const store = new SettlementStore();
  const base = {
    store, quoteClient: { async getQuote() { throw new Error('must not be called'); } },
    authenticateRequest: async () => ({ subject: 'session-user-1' }),
    resolveMemberIdentity: async () => 'member-from-db',
    resolveTrustedContext: async () => trusted,
  };
  assert.throws(() => createMemberQuoteHandler({ ...base, authenticateRequest: undefined }), /authentication callback/);
  assert.throws(() => createMemberQuoteHandler({ ...base, resolveMemberIdentity: undefined }), /identity resolver/);
  assert.throws(() => createMemberQuoteHandler({ ...base, resolveTrustedContext: undefined }), /context resolver/);
  store.close();
});

test('rejects oversized framework-parsed body before quote creation', async () => {
  const ctx = setup(); const res = response();
  await ctx.handler(request({ ...validBody, padding: 'x'.repeat(17 * 1024) }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'BODY_TOO_LARGE');
  assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});

test('rejects malformed JSON and non-object JSON bodies safely', async () => {
  const ctx = setup();
  let res = response();
  await ctx.handler(request(null, { async *[Symbol.asyncIterator]() { yield '{invalid'; } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'INVALID_JSON');
  res = response();
  await ctx.handler(request(null, { async *[Symbol.asyncIterator]() { yield '[]'; } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'INVALID_BODY');
  assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});

test('rejects inactive trusted circle/member/round and resolver identity mismatch without persistence', async () => {
  for (const override of [
    { circleStatus: 'INACTIVE' },
    { memberStatus: 'SUSPENDED' },
    { roundStatus: 'CLOSED' },
    { memberId: 'different-member' },
  ]) {
    const ctx = setup({ resolveTrustedContext: async ids => ({ ...trusted, ...ids, ...override }) });
    const res = response();
    await ctx.handler(request(), res);
    assert.equal(res.statusCode, override.memberId ? 403 : 422);
    assert.equal(ctx.store.getIntent('intent-api-1'), null);
    assert.equal(ctx.calls.quote, 0);
    ctx.store.close();
  }
});

test('rejects invalid slippage and deposit mode without persisting an intent', async () => {
  for (const extra of [{ slippageTolerance: -1 }, { depositMode: 'UNSAFE_MODE' }]) {
    const ctx = setup(); const res = response();
    await ctx.handler(request({ ...validBody, ...extra }), res);
    assert.equal(res.statusCode, 422);
    assert.equal(ctx.store.getIntent('intent-api-1'), null);
    ctx.store.close();
  }
});


test('missing trusted quote context is not mislabeled as missing membership', async () => {
  const ctx = setup({ resolveTrustedContext: async () => null });
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'QUOTE_CONTEXT_NOT_READY');
  assert.match(res.body.message, /Refresh contract verification/);
  assert.equal(ctx.calls.quote, 0);
  assert.equal(ctx.store.getIntent('intent-api-1'), null);
  ctx.store.close();
});

test('preview returns a specific expired-round error before calling the provider', async () => {
  const ctx = setup({
    clock: () => new Date('2031-01-01T00:00:00.000Z'),
    quoteClient: {
      async getQuote() { throw new Error('committed path must not run'); },
      async getQuotePreview() { throw new Error('provider must not be called for an expired round'); },
    },
  });
  const res = response();
  await ctx.handler({ ...request(), url: MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'ROUND_DEADLINE_PASSED');
  assert.match(res.body.message, /deadline has passed/);
  assert.equal(ctx.store.getIntent('intent-api-1'), null);
  ctx.store.close();
});

test('preview endpoint is authenticated, dry-only, and never persists an intent', async () => {
  const ctx = setup({
    quoteBackendConfigured: false,
    quoteClient: {
      async getQuote() { throw new Error('committed quote path must not run'); },
      async getQuotePreview(request) {
        ctxCalls.quote++;
        assert.equal(request.dry, true);
        assert.equal(request.recipient, 'alice.near');
        assert.equal(request.refundTo, '0xregistered-wallet');
        return {
          originAsset: request.originAsset,
          destinationAsset: request.destinationAsset,
          recipient: request.recipient,
          amountIn: request.amount,
          amountOut: quote.amountOut,
          minimumAmountOut: quote.minimumAmountOut,
          deadline: request.deadline,
          depositAddress: 'provider-field-must-not-escape',
        };
      },
    },
  });
  const ctxCalls = { quote: 0 };
  const res = response();
  await ctx.handler({ ...request(), url: MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quote.status, 'PREVIEW_ONLY');
  assert.equal(res.body.quote.contributionReady, false);
  assert.equal('depositAddress' in res.body.quote, false);
  assert.equal(ctxCalls.quote, 1);
  assert.equal(ctx.store.getIntent('intent-api-1'), null);
  ctx.store.close();
});

test('preview endpoint rejects unauthenticated users before membership or provider lookup', async () => {
  const ctx = setup({ authenticateRequest: async () => null });
  const res = response();
  await ctx.handler({ ...request(), url: MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'UNAUTHENTICATED');
  assert.equal(ctx.calls.identity, 0);
  assert.equal(ctx.calls.quote, 0);
  ctx.store.close();
});


test('preview provider failures are logged with a safe stage while the client receives only a generic rejection', async () => {
  const diagnostics = [];
  const ctx = setup({
    onError: detail => diagnostics.push(detail),
    quoteClient: {
      async getQuote() { throw new Error('committed quote path must not run'); },
      async getQuotePreview() { throw new Error('1Click quote endpoint returned HTTP 400'); },
    },
  });
  const res = response();
  await ctx.handler({ ...request(), url: MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH }, res);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { error: 'QUOTE_REQUEST_REJECTED' });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].stage, 'provider_preview');
  assert.match(diagnostics[0].message, /HTTP 400/);
  assert.equal(JSON.stringify(res.body).includes('HTTP 400'), false);
  assert.equal(ctx.store.getIntent('intent-api-1'), null);
  ctx.store.close();
});
