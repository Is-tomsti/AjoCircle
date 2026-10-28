import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementStore } from './settlement-store.mjs';
import { createTrustedMemberQuote, createTrustedMemberQuotePreview } from './quote-service.mjs';

const trusted = {
  circleId: 'circle-1', memberId: 'member-1', round: 2,
  circleStatus: 'ACTIVE', memberStatus: 'ACTIVE', roundStatus: 'OPEN',
  memberNearAccount: 'alice.near', requiredContributionAmount: '1000000000000000000000000',
  allowedOriginAssets: ['asset:usdc-base'],
  refundAddresses: { 'asset:usdc-base': '0xregistered-wallet' },
  maxInputAmounts: { 'asset:usdc-base': '5000000' },
  roundDeadlineMs: 1900000000000,
};
const quote = {
  depositAddress: 'quote-deposit-1', depositMemo: 'memo-123', originAsset: 'asset:usdc-base',
  destinationAsset: 'nep141:wrap.near', recipient: 'alice.near', amountIn: '2000000',
  amountOut: '1100000000000000000000000', minimumAmountOut: '1050000000000000000000000',
  deadline: '2026-10-20T20:40:00.000Z', signature: 'sig-1', correlationId: 'corr-1',
};
const setup = () => {
  const store = new SettlementStore();
  const quoteClient = { async getQuote(request) { assert.equal(request.recipient, 'alice.near'); assert.equal(request.refundTo, '0xregistered-wallet'); return quote; } };
  const resolveTrustedContext = async ids => ({ ...trusted, ...ids });
  return { store, quoteClient, resolveTrustedContext };
};
const args = (extra = {}) => ({ ...setup(), circleId: 'circle-1', memberId: 'member-1', round: 2, originAsset: 'asset:usdc-base', amount: '2000000', refundTo: '0xregistered-wallet', clock: () => new Date('2026-10-20T20:25:00.000Z'), idFactory: () => 'intent-created-1', ...extra });

test('creates a quote intent from trusted member context and persists quote evidence', async () => {
  const input = args();
  const result = await createTrustedMemberQuote(input);
  assert.equal(result.intentId, 'intent-created-1');
  assert.equal(result.depositAddress, 'quote-deposit-1');
  assert.equal(result.depositMemo, 'memo-123');
  assert.equal(result.minimumAmountOut, quote.minimumAmountOut);
  const stored = input.store.getIntent(result.intentId);
  assert.equal(stored.circleId, 'circle-1');
  assert.equal(stored.memberId, 'member-1');
  assert.equal(stored.depositMemo, 'memo-123');
  assert.equal(stored.quoteSignature, 'sig-1');
  assert.equal(stored.requiredContributionAmount, trusted.requiredContributionAmount);
  assert.equal(stored.status, 'PENDING');
  input.store.close();
});

test('rejects completed or inactive circles and closed rounds before contacting quote providers', async () => {
  for (const lifecycle of [
    { circleStatus: 'COMPLETED' },
    { circleStatus: 'INACTIVE' },
    { roundStatus: 'CLOSED' },
  ]) {
    let providerCalled = false;
    const input = args({
      quoteClient: {
        async getQuote() { providerCalled = true; throw new Error('provider must not be called'); },
        async getQuotePreview() { providerCalled = true; throw new Error('provider must not be called'); },
      },
      resolveTrustedContext: async ids => ({ ...trusted, ...ids, ...lifecycle }),
    });
    await assert.rejects(createTrustedMemberQuote(input), /active\/open/);
    await assert.rejects(createTrustedMemberQuotePreview(input), /active\/open/);
    assert.equal(providerCalled, false, 'completed or closed circle must be blocked before provider access');
    assert.equal(input.store.getIntent('intent-created-1'), null);
    input.store.close();
  }
});

test('rejects inactive state, unregistered wallet, unapproved asset, and excessive amount', async () => {
  let input = args({ resolveTrustedContext: async ids => ({ ...trusted, ...ids, roundStatus: 'CLOSED' }) });
  await assert.rejects(createTrustedMemberQuote(input), /active\/open/); input.store.close();
  input = args({ refundTo: '0xattacker-wallet' });
  await assert.rejects(createTrustedMemberQuote(input), /registered/); input.store.close();
  input = args({ originAsset: 'asset:unknown' });
  await assert.rejects(createTrustedMemberQuote(input), /not enabled/); input.store.close();
  input = args({ amount: '5000001' });
  await assert.rejects(createTrustedMemberQuote(input), /exceeds/); input.store.close();
});

test('rejects expired rounds before contacting the quote provider and caps quote expiry at the round deadline', async () => {
  let called = false;
  let input = args({
    clock: () => new Date(trusted.roundDeadlineMs),
    quoteClient: { async getQuote() { called = true; return quote; } },
  });
  await assert.rejects(createTrustedMemberQuote(input), /deadline has passed/);
  assert.equal(called, false);
  assert.equal(input.store.getIntent('intent-created-1'), null);
  input.store.close();

  let captured;
  input = args({
    clock: () => new Date(trusted.roundDeadlineMs - 60_000),
    quoteClient: { async getQuote(request) { captured = request; return { ...quote, deadline: request.deadline }; } },
  });
  await createTrustedMemberQuote(input);
  assert.equal(captured.deadline, new Date(trusted.roundDeadlineMs).toISOString());
  input.store.close();
});

test('rejects quote output below contribution amount and mismatched trusted context', async () => {
  let input = args({ quoteClient: { async getQuote() { return { ...quote, minimumAmountOut: '999' }; } } });
  await assert.rejects(createTrustedMemberQuote(input), /insufficient/); input.store.close();
  input = args({ quoteClient: { async getQuote() { return quote; } }, resolveTrustedContext: async ids => ({ ...trusted, ...ids, memberNearAccount: 'attacker.near' }) });
  await assert.rejects(createTrustedMemberQuote(input), /quote does not match/); input.store.close();
});


test('creates estimate-only preview without requiring or persisting a settlement intent', async () => {
  const input = args({
    quoteClient: {
      async getQuotePreview(request) {
        assert.equal(request.dry, true);
        assert.equal(request.recipient, 'alice.near');
        assert.equal(request.refundTo, '0xregistered-wallet');
        return {
          originAsset: request.originAsset,
          destinationAsset: request.destinationAsset,
          recipient: request.recipient,
          amountIn: request.amount,
          amountOut: '1100000000000000000000000',
          minimumAmountOut: '1050000000000000000000000',
          deadline: request.deadline,
          amountOutFormatted: '1.1 wNEAR',
          amountOutUsd: '5.00',
          timeEstimate: 8,
          correlationId: 'preview-1',
          depositAddress: 'must-not-be-returned',
        };
      },
    },
  });
  const result = await createTrustedMemberQuotePreview(input);
  assert.equal(result.status, 'PREVIEW_ONLY');
  assert.equal(result.contributionReady, false);
  assert.equal(result.destinationAsset, 'nep141:wrap.near');
  assert.match(result.note, /not a native-NEAR contract contribution/);
  assert.equal('depositAddress' in result, false);
  assert.equal(input.store.getIntent('intent-created-1'), null);
  input.store.close();
});

test('preview fails closed on inactive state, wrong wallet, invalid amount, or insufficient output shape', async () => {
  let input = args({
    quoteClient: { async getQuotePreview() { throw new Error('must not call provider'); } },
    resolveTrustedContext: async ids => ({ ...trusted, ...ids, roundStatus: 'CLOSED' }),
  });
  await assert.rejects(createTrustedMemberQuotePreview(input), /active\/open/);
  input.store.close();

  input = args({
    refundTo: '0xattacker-wallet',
    quoteClient: { async getQuotePreview() { throw new Error('must not call provider'); } },
  });
  await assert.rejects(createTrustedMemberQuotePreview(input), /registered/);
  input.store.close();

  input = args({
    quoteClient: { async getQuotePreview(request) {
      return { originAsset: request.originAsset, destinationAsset: request.destinationAsset,
        recipient: request.recipient, amountIn: request.amount, amountOut: '10', minimumAmountOut: '11',
        deadline: request.deadline };
    } },
  });
  await assert.rejects(createTrustedMemberQuotePreview(input), /below minimumAmountOut/);
  input.store.close();
});
