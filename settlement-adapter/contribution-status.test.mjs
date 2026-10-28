import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementStore } from './settlement-store.mjs';
import { getMemberContributionStatus } from './contribution-status.mjs';

const record = { intentId: 'status-intent', depositAddress: 'status-deposit', circleId: 'circle-1', memberId: 'alice.near', round: 0, destinationAsset: 'nep141:wrap.near', recipient: 'alice.near', minimumAmountOut: '100', requiredContributionAmount: '1000000000000000000000000' };
const views = (overrides = {}) => ({ getRound: async () => 0, getContribution: async () => null, isCircleCompleted: async () => false, isPayoutPending: async () => false, isPayoutComplete: async () => false, ...overrides });
const setup = (overrides = {}, intentRecord = record) => { const store = new SettlementStore(); store.createPendingIntent(intentRecord); return { store, contractClient: views(overrides), intentId: intentRecord.intentId }; };

test('queries the contract with the NEAR recipient, not the internal membership ID', async () => {
  const intentRecord = { ...record, memberId: 'membership-row-1' };
  const input = setup({ getContribution: async ({ member }) => { assert.equal(member, 'alice.near'); return null; } }, intentRecord);
  const result = await getMemberContributionStatus(input);
  assert.equal(result.memberId, 'membership-row-1');
  assert.equal(result.memberNearAccount, 'alice.near');
  input.store.close();
});

test('does not confuse successful swap delivery with a contract contribution', async () => {
  const input = setup();
  const result = await getMemberContributionStatus(input);
  assert.equal(result.swapStatus, 'AWAITING_SWAP_DELIVERY');
  assert.equal(result.contractStatus, 'NO_CONTRIBUTION');
  assert.equal(result.nextAction, 'WAIT_FOR_SWAP_SETTLEMENT');
  input.store.close();
});

test('after swap delivery, directs the member to unwrap and submit native NEAR', async () => {
  const input = setup();
  input.store.claimVerifiedDelivery(record.intentId, { status: 'SUCCESS', depositAddress: record.depositAddress, destinationAsset: record.destinationAsset, recipient: record.recipient, amountOut: '100', destinationTxHashes: ['tx-1'] });
  const result = await getMemberContributionStatus(input);
  assert.equal(result.swapStatus, 'SWAP_DELIVERED');
  assert.equal(result.contractStatus, 'NO_CONTRIBUTION');
  assert.equal(result.nextAction, 'UNWRAP_AND_SUBMIT_NATIVE_NEAR_CONTRIBUTION');
  input.store.close();
});

test('confirms contribution only when contract round and exact amount match', async () => {
  const input = setup({ getContribution: async () => record.requiredContributionAmount });
  const result = await getMemberContributionStatus(input);
  assert.equal(result.contractStatus, 'CONTRIBUTION_CONFIRMED');
  assert.equal(result.nextAction, 'CONTRIBUTION_CONFIRMED');
  input.store.close();
});

test('flags a changed round, wrong amount, and completed circle', async () => {
  let input = setup({ getRound: async () => 1, getContribution: async () => record.requiredContributionAmount });
  assert.equal((await getMemberContributionStatus(input)).contractStatus, 'ROUND_MISMATCH'); input.store.close();
  input = setup({ getContribution: async () => '7' });
  assert.equal((await getMemberContributionStatus(input)).contractStatus, 'AMOUNT_MISMATCH'); input.store.close();
  input = setup({ isCircleCompleted: async () => true, getContribution: async () => record.requiredContributionAmount });
  assert.equal((await getMemberContributionStatus(input)).contractStatus, 'CIRCLE_COMPLETED'); input.store.close();
});

test('rejects missing intent, missing trusted amount, and malformed contract views', async () => {
  const store = new SettlementStore();
  await assert.rejects(getMemberContributionStatus({ store, contractClient: views(), intentId: 'missing' }), /not found/);
  store.createPendingIntent({ ...record, intentId: 'legacy-status', requiredContributionAmount: undefined });
  await assert.rejects(getMemberContributionStatus({ store, contractClient: views(), intentId: 'legacy-status' }), /no trusted/);
  store.close();
  const input = setup({ getRound: async () => -1 });
  await assert.rejects(getMemberContributionStatus(input), /non-negative/);
  input.store.close();
});
