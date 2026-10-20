import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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


test('adds quote metadata columns to an existing legacy database without losing records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ajocircle-legacy-schema-'));
  const path = join(directory, 'settlement.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE pending_intents (
      intent_id TEXT PRIMARY KEY, deposit_address TEXT NOT NULL UNIQUE, circle_id TEXT NOT NULL,
      member_id TEXT NOT NULL, round_number INTEGER NOT NULL CHECK (round_number >= 0),
      destination_asset TEXT NOT NULL, recipient TEXT NOT NULL, minimum_amount_out TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'VERIFIED_DELIVERY')), amount_out TEXT,
      destination_tx_hashes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.prepare(`INSERT INTO pending_intents
      (intent_id, deposit_address, circle_id, member_id, round_number, destination_asset, recipient,
       minimum_amount_out, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
    ).run('legacy-1', 'legacy-deposit', 'circle-1', 'member-1', 1, 'nep141:wrap.near', 'alice.near', '100', tick(), tick());
    legacy.close();

    const store = new SettlementStore({ path, clock: tick });
    assert.equal(store.getIntent('legacy-1').status, 'PENDING');
    store.createPendingIntent(intent({
      intentId: 'new-quote-1', depositAddress: 'new-deposit', depositMemo: 'memo-1',
      originAsset: 'asset:source', amountIn: '200', quotedAmountOut: '150',
      quoteDeadline: '2026-10-21T00:00:00Z', quoteSignature: 'signature-1', quoteCorrelationId: 'corr-1',
    }));
    const saved = store.getIntent('new-quote-1');
    assert.equal(saved.depositMemo, 'memo-1');
    assert.equal(saved.originAsset, 'asset:source');
    assert.equal(saved.quoteSignature, 'signature-1');
    assert.equal(saved.quoteCorrelationId, 'corr-1');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
