import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicDistributionExecutionStore } from './public-distribution-execution-store.mjs';

const plan = [
  { member: 'member-a.testnet', amountYocto: '3' },
  { member: 'member-b.testnet', amountYocto: '3' },
];
const totalYocto = '6';

test('uncertain submission preserves the transaction hash for reconciliation', () => {
  const store = new PublicDistributionExecutionStore();
  try {
    const prepared = store.prepare({
      circleId: 'circle-recovery-test',
      preparedBy: 'member-a.testnet',
      contractId: 'recovery.testnet',
      codeSha256: 'a'.repeat(64),
      round: 99,
      plan,
      totalYocto,
      network: 'testnet',
    });

    const phrase =
      `AUTHORIZE TESTNET DISTRIBUTION ${prepared.contractId} ROUND ${prepared.round} TOTAL ${prepared.totalYocto} YOCTO`;

    store.authorize(prepared.id, {
      actor: 'member-b.testnet',
      confirmation: phrase,
    });

    const txHash = '1'.repeat(44);

    assert.equal(typeof store.recordAttempt, 'function',
      'store must implement recordAttempt before this recovery test can pass');

    const attempted = store.recordAttempt(prepared.id, {
      txHash,
      action: 'start',
      round: prepared.round,
      recipientIndex: 0,
      recipient: plan[0].member,
      recordedAt: new Date().toISOString(),
    });

    assert.equal(attempted.state, 'AUTHORIZED');
    assert.deepEqual(attempted.txHashes, []);
    assert.deepEqual(attempted.attempts.map(x => x.txHash), [txHash]);
    assert.equal(attempted.attempts[0].outcome, 'UNKNOWN');

    const reconciled = store.recordAttemptOutcome(
      prepared.id,
      txHash,
      'VERIFIED_FAILURE',
    );
    assert.equal(reconciled.attempts[0].outcome, 'VERIFIED_FAILURE');
    assert.throws(
      () => store.recordAttemptOutcome(prepared.id, txHash, 'VERIFIED_SUCCESS'),
      /cannot be overwritten/,
    );
    assert.equal(store.get(prepared.id).attempts[0].outcome, 'VERIFIED_FAILURE');
    assert.throws(
      () => store.recordAttemptOutcome(prepared.id, txHash, 'FORGED_SUCCESS'),
      /Valid verified attempt outcome/,
    );

    const unknown = store.recordUnknown(
      prepared.id,
      'Finalized RPC verification unavailable',
    );

    assert.equal(unknown.state, 'UNKNOWN');
    assert.deepEqual(unknown.attempts.map(x => x.txHash), [txHash]);

    const resolved = store.resolveVerifiedFailure(prepared.id, txHash);
    assert.equal(resolved.state, 'AUTHORIZED');
    assert.deepEqual(resolved.txHashes, []);
    assert.equal(resolved.attempts[0].outcome, 'VERIFIED_FAILURE');
  } finally {
    store.close();
  }
});
