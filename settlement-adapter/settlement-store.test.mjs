import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettlementStore } from './settlement-store.mjs';
import { parseOneClickStatus } from './oneclick.mjs';

const intent = (overrides = {}) => ({
  intentId: 'intent-001',
  depositAddress: 'deposit-unique-001',
  circleId: 'circle-7',
  memberId: 'member-9',
  round: 2,
  destinationAsset: 'nep141:wrap.near',
  recipient: 'alice.near',
  minimumAmountOut: '2500',
  ...overrides,
});
const payload = (overrides = {}) => ({
  status: 'SUCCESS',
  quoteResponse: {
    quote: { depositAddress: 'deposit-unique-001' },
    request: { destinationAsset: 'nep141:wrap.near', recipient: 'alice.near' },
  },
  swapDetails: { amountOut: '2600', destinationChainTxHashes: [{ hash: 'tx-destination-001' }] },
  ...overrides,
});
const tick = () => new Date().toISOString();

test('creates and reads a trusted pending intent', () => {
  const store = new SettlementStore();
  const created = store.createPendingIntent(intent());
  assert.equal(created.intentId, 'intent-001');
  assert.equal(created.status, 'PENDING');
  assert.equal(store.getIntent('intent-001').circleId, 'circle-7');
  store.close();
});

test('rejects duplicate intent IDs and deposit addresses', () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent());
  assert.throws(() => store.createPendingIntent(intent({ circleId: 'circle-other' })));
  assert.throws(() => store.createPendingIntent(intent({
    intentId: 'intent-002', depositAddress: 'deposit-unique-001',
  })));
  store.close();
});

test('validates required fields, round, and integer minimum amount', () => {
  const store = new SettlementStore();
  assert.throws(() => store.createPendingIntent(intent({ memberId: '  ' })));
  assert.throws(() => store.createPendingIntent(intent({ round: -1 })));
  assert.throws(() => store.createPendingIntent(intent({ minimumAmountOut: '2.5' })));
  store.close();
});

test('atomically consumes a successful delivery once and records transaction evidence', () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent());
  const observed = parseOneClickStatus(payload());
  const claimed = store.claimVerifiedDelivery('intent-001', observed);
  assert.equal(claimed.status, 'VERIFIED_DELIVERY');
  assert.equal(claimed.amountOut, '2600');
  assert.deepEqual(claimed.destinationTxHashes, ['tx-destination-001']);
  assert.throws(() => store.claimVerifiedDelivery('intent-001', observed), /cannot be consumed/);
  store.close();
});

test('rolls back when delivery fields do not match the trusted intent', () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent());
  assert.throws(() => store.claimVerifiedDelivery('intent-001', parseOneClickStatus(payload({
    quoteResponse: {
      quote: { depositAddress: 'attacker-address' },
      request: { destinationAsset: 'nep141:wrap.near', recipient: 'alice.near' },
    },
  }))), /does not match/);
  assert.equal(store.getIntent('intent-001').status, 'PENDING');
  store.close();
});

test('global transaction uniqueness blocks replay across different intents and rolls back', () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent());
  store.createPendingIntent(intent({
    intentId: 'intent-002',
    depositAddress: 'deposit-unique-002',
    circleId: 'circle-8',
  }));
  store.claimVerifiedDelivery('intent-001', parseOneClickStatus(payload()));
  const replay = payload({
    quoteResponse: {
      quote: { depositAddress: 'deposit-unique-002' },
      request: { destinationAsset: 'nep141:wrap.near', recipient: 'alice.near' },
    },
  });
  assert.throws(() => store.claimVerifiedDelivery('intent-002', parseOneClickStatus(replay)));
  assert.equal(store.getIntent('intent-002').status, 'PENDING');
  assert.equal(store.getIntent('intent-002').destinationTxHashes.length, 0);
  store.close();
});

test('persists pending and consumed records after reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ajocircle-settlement-'));
  const path = join(directory, 'settlement.sqlite');
  try {
    let store = new SettlementStore({ path, clock: tick });
    store.createPendingIntent(intent());
    store.close();

    store = new SettlementStore({ path, clock: tick });
    assert.equal(store.getIntent('intent-001').status, 'PENDING');
    store.claimVerifiedDelivery('intent-001', parseOneClickStatus(payload()));
    store.close();

    store = new SettlementStore({ path, clock: tick });
    const restored = store.getIntent('intent-001');
    assert.equal(restored.status, 'VERIFIED_DELIVERY');
    assert.equal(restored.amountOut, '2600');
    assert.deepEqual(restored.destinationTxHashes, ['tx-destination-001']);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not accept an unsuccessful status as a verified delivery', () => {
  const store = new SettlementStore();
  store.createPendingIntent(intent());
  assert.throws(() => store.claimVerifiedDelivery('intent-001', parseOneClickStatus(payload({ status: 'PROCESSING' }))));
  assert.equal(store.getIntent('intent-001').status, 'PENDING');
  store.close();
});

test('independent SQLite connections cannot consume the same intent twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ajocircle-multi-connection-'));
  const path = join(directory, 'settlement.sqlite');
  const first = new SettlementStore({ path, clock: tick });
  const second = new SettlementStore({ path, clock: tick });
  try {
    first.createPendingIntent(intent());
    const observed = parseOneClickStatus(payload());
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => first.claimVerifiedDelivery('intent-001', observed)),
      Promise.resolve().then(() => second.claimVerifiedDelivery('intent-001', observed)),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(first.getIntent('intent-001').status, 'VERIFIED_DELIVERY');
    assert.deepEqual(first.getIntent('intent-001').destinationTxHashes, ['tx-destination-001']);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
