import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberMediatedQuoteRequest } from './quote-request.mjs';

const valid = {
  originAsset: 'nep141:base-usdc.omft.near',
  amount: '1000000',
  memberNearAccount: 'member.near',
  refundTo: '0x1234567890abcdef',
  deadline: '2026-10-20T12:00:00Z',
};

test('builds exact-input quote targeting the member with wrapped NEAR', () => {
  const request = buildMemberMediatedQuoteRequest(valid);
  assert.equal(request.dry, false);
  assert.equal(request.swapType, 'EXACT_INPUT');
  assert.equal(request.destinationAsset, 'nep141:wrap.near');
  assert.equal(request.recipient, 'member.near');
  assert.equal(request.refundTo, valid.refundTo);
  assert.equal(request.depositType, 'ORIGIN_CHAIN');
  assert.equal(request.refundType, 'ORIGIN_CHAIN');
  assert.equal(request.recipientType, 'DESTINATION_CHAIN');
  assert.equal(request.amount, '1000000');
  assert.equal(Object.isFrozen(request), true);
});

test('rejects invalid amount, missing recipient, and unsafe slippage', () => {
  assert.throws(() => buildMemberMediatedQuoteRequest({ ...valid, amount: '1.5' }), /positive base-unit/);
  assert.throws(() => buildMemberMediatedQuoteRequest({ ...valid, memberNearAccount: ' ' }), /memberNearAccount/);
  assert.throws(() => buildMemberMediatedQuoteRequest({ ...valid, slippageTolerance: 10001 }), /slippageTolerance/);
  assert.throws(() => buildMemberMediatedQuoteRequest({ ...valid, depositMode: 'AUTO' }), /depositMode/);
});
