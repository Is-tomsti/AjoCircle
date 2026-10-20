import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementStore } from './settlement-store.mjs';
import { parseOneClickStatus } from './oneclick.mjs';
import { verifyPendingIntentDelivery } from './settlement-service.mjs';

const intent = {
  intentId: 'service-intent-1',
  depositAddress: 'trusted-deposit-1',
  circleId: 'circle-1',
  memberId: 'member-1',
  round: 1,
  destinationAsset: 'nep141:wrap.near',
  recipient: 'alice.near',
  minimumAmountOut: '100',
};
const payload = {
  status: 'SUCCESS',
  quoteResponse: {
    quote: { depositAddress: 'trusted-deposit-1' },
    request: { destinationAsset: 'nep141:wrap.near', recipient: 'alice.near' },
  },
  swapDetails: { amountOut: '120', destinationChainTxHashes: [{ hash: 'service-tx-1' }] },
};

test('service gets the deposit address from the trusted stored intent and persists success', async () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent);
  let requestedAddress;
  const statusClient = {
    async getStatus({ depositAddress }) {
      requestedAddress = depositAddress;
      return parseOneClickStatus(payload);
    },
  };
  const result = await verifyPendingIntentDelivery({ store, statusClient, intentId: intent.intentId });
  assert.equal(requestedAddress, 'trusted-deposit-1');
  assert.equal(result.status, 'VERIFIED_DELIVERY');
  assert.equal(result.amountOut, '120');
  store.close();
});

test('service never uses a caller-supplied deposit address or member identity', async () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent);
  let requestedAddress;
  const statusClient = {
    async getStatus(args) {
      requestedAddress = args.depositAddress;
      return parseOneClickStatus(payload);
    },
  };
  await verifyPendingIntentDelivery({
    store,
    statusClient,
    intentId: intent.intentId,
    depositAddress: 'attacker-deposit',
    memberId: 'attacker.near',
  });
  assert.equal(requestedAddress, intent.depositAddress);
  assert.equal(store.getIntent(intent.intentId).memberId, intent.memberId);
  store.close();
});

test('concurrent polling attempts can consume a stored intent only once', async () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent);
  const statusClient = {
    async getStatus() {
      await new Promise(resolve => setImmediate(resolve));
      return parseOneClickStatus(payload);
    },
  };
  const results = await Promise.allSettled([
    verifyPendingIntentDelivery({ store, statusClient, intentId: intent.intentId }),
    verifyPendingIntentDelivery({ store, statusClient, intentId: intent.intentId }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(store.getIntent(intent.intentId).status, 'VERIFIED_DELIVERY');
  store.close();
});

test('service fails closed for unknown or already verified intent', async () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent);
  const statusClient = { async getStatus() { return parseOneClickStatus(payload); } };
  await assert.rejects(
    verifyPendingIntentDelivery({ store, statusClient, intentId: 'missing' }),
    /not found/,
  );
  await verifyPendingIntentDelivery({ store, statusClient, intentId: intent.intentId });
  await assert.rejects(
    verifyPendingIntentDelivery({ store, statusClient, intentId: intent.intentId }),
    /cannot be checked/,
  );
  store.close();
});
