import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementStore } from './settlement-store.mjs';
import { createTrustedMemberQuote } from './quote-service.mjs';

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
