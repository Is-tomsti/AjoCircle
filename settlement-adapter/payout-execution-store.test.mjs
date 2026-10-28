import test from 'node:test';
import assert from 'node:assert/strict';
import { PayoutExecutionStore } from './payout-execution-store.mjs';

const HASH = 'a'.repeat(64);
const TX = '11111111111111111111111111111111';
const ready = (overrides = {}) => ({
  status: 'ready', transactionSubmitted: false, network: 'testnet',
  contractId: 'ajo-demo-fresh.testnet', recipient: 'ajotest1.testnet',
  round: 0, codeSha256: HASH, bindingVerified: true, amountYocto: '3000000000000000000000000',
  ...overrides,
});
function setup() { return new PayoutExecutionStore(); }
function prepare(store, readiness = ready()) {
  return store.prepare({ readiness, circleId: 'circle-1', preparedBy: 'operator.testnet' });
}

test('requires ready, verified testnet preflight and exact amount', () => {
  const store = setup();
  assert.throws(() => prepare(store, ready({ status: 'waiting' })), /status ready/);
  assert.throws(() => prepare(store, ready({ network: 'mainnet' })), /testnet-only/);
  assert.throws(() => prepare(store, ready({ bindingVerified: false })), /binding/);
  assert.throws(() => prepare(store, ready({ amountYocto: '3.0' })), /amount/);
  store.close();
});

test('prepares once per contract round and returns existing plan on duplicate request', () => {
  const store = setup();
  const first = prepare(store);
  const second = prepare(store);
  assert.equal(first.id, second.id);
  assert.equal(first.state, 'PREPARED');
  assert.equal(first.network, 'testnet');
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  store.close();
});

test('rejects conflicting amount or recipient for an already-planned contract round', () => {
  const store = setup();
  const plan = prepare(store);
  assert.throws(() => prepare(store, ready({ amountYocto: '4000000000000000000000000' })), /Conflicting payout plan/);
  assert.equal(store.get(plan.id).state, 'PREPARED');
  store.close();
});

test('authorization requires exact phrase and an independent second operator', () => {
  const store = setup();
  const plan = prepare(store);
  assert.throws(() => store.authorize(plan.id, { actor: plan.preparedBy, confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` }), /second, independently authenticated operator/);
  assert.throws(() => store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: 'yes' }), /confirmation phrase/);
  const authorized = store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` });
  assert.equal(authorized.state, 'AUTHORIZED');
  assert.equal(authorized.authorizedBy, 'reviewer.testnet');
  store.close();
});

test('does not permit submission record before authorization or invalid transaction hash', () => {
  const store = setup();
  const plan = prepare(store);
  assert.throws(() => store.recordSubmitted(plan.id, TX), /state PREPARED/);
  store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` });
  assert.throws(() => store.recordSubmitted(plan.id, 'not-a-tx'), /hash format/);
  assert.equal(store.recordSubmitted(plan.id, TX).state, 'SUBMITTED');
  store.close();
});

test('uncertain submission becomes UNKNOWN and cannot be resubmitted', () => {
  const store = setup();
  const plan = prepare(store);
  store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` });
  const unknown = store.recordUnknown(plan.id, 'RPC timed out after request');
  assert.equal(unknown.state, 'UNKNOWN');
  assert.throws(() => store.recordSubmitted(plan.id, TX), /state UNKNOWN/);
  store.close();
});

test('finalization requires matching transaction and verified successful finality evidence', () => {
  const store = setup();
  const plan = prepare(store);
  store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` });
  store.recordSubmitted(plan.id, TX);
  assert.throws(() => store.recordFinalized(plan.id, { txHash: TX, finalityVerified: false, outcome: 'SUCCESS', evidenceReference: 'explorer' }), /finality evidence/);
  assert.throws(() => store.recordFinalized(plan.id, { txHash: '22222222222222222222222222222222', finalityVerified: true, outcome: 'SUCCESS', evidenceReference: 'explorer' }), /does not match/);
  const done = store.recordFinalized(plan.id, { txHash: TX, finalityVerified: true, outcome: 'SUCCESS', evidenceReference: 'verified-rpc-result' });
  assert.equal(done.state, 'FINALIZED');
  assert.equal(done.finalityEvidence.txHash, TX);
  store.close();
});

test('definitive failure requires evidence and permanently occupies the round key', () => {
  const store = setup();
  const plan = prepare(store);
  store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` });
  assert.throws(() => store.recordDefinitiveFailure(plan.id, { failureConfirmed: false, reason: 'timeout' }), /definitive/);
  assert.equal(store.recordDefinitiveFailure(plan.id, { failureConfirmed: true, reason: 'verified contract rejection' }).state, 'FAILED');
  assert.equal(prepare(store).id, plan.id);
  store.close();
});

test('terminal states cannot be changed', () => {
  const store = setup();
  const plan = prepare(store);
  store.authorize(plan.id, { actor: 'reviewer.testnet', confirmation: `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND 0` });
  store.recordDefinitiveFailure(plan.id, { failureConfirmed: true, reason: 'verified rejection' });
  assert.throws(() => store.recordUnknown(plan.id, 'later timeout'), /state FAILED/);
  store.close();
});
