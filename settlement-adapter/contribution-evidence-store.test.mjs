import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContributionEvidenceStore } from './contribution-evidence-store.mjs';

const evidence = {
  verified: true, outcome: 'ON_TIME', network: 'testnet',
  transactionHash: '4WDSWBFwoukZrRBDfuZffBfZrgrajGoBrfBwuMHHsMBE',
  evidenceRef: 'near:testnet:tx:4WDSWBFwoukZrRBDfuZffBfZrgrajGoBrfBwuMHHsMBE',
  signerId: 'alice.testnet', contractId: 'circle.testnet',
  amountYocto: '1000000000000000000000000', deadlineNs: '1800000000000000000',
  blockHash: '2atms6gpLFZPn4ojnQ1NXxfAj6sAWh4uQ6ky8x6rjjTe', digest: 'sha256:base-proof',
};
const binding = {
  verified: true, network: 'testnet', transactionHash: evidence.transactionHash,
  contractId: evidence.contractId, signerId: evidence.signerId, circleId: 'circle-1',
  round: 0, blockHash: evidence.blockHash, proofRef: 'fastnear:testnet:tx:tx:receipt:r1',
  proofDigest: 'sha256:round-proof',
};
function record(store, overrides = {}) {
  return store.recordVerifiedEvidence({
    evidence, binding, circleId: 'circle-1', memberId: 'member-1', round: 0,
    expectedAmountYocto: evidence.amountYocto, expectedDeadlineNs: evidence.deadlineNs,
    ...overrides,
  });
}
test('durable evidence handoff verifies exact event obligation and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ajo-evidence-'));
  const path = join(dir, 'evidence.sqlite');
  try {
    let store = new ContributionEvidenceStore({ path });
    const accepted = record(store);
    assert.equal(accepted.verified, true);
    assert.equal(store.verifyReference({ evidenceRef: accepted.evidenceRef, memberId: 'member-1', circleId: 'circle-1', eventKind: 'OBLIGATION', payload: { obligationId: 'circle-1:0:member-1', outcome: 'ON_TIME' } }).verified, true);
    store.close();
    store = new ContributionEvidenceStore({ path });
    try {
      assert.equal(store.verifyReference({ evidenceRef: accepted.evidenceRef, memberId: 'member-1', circleId: 'circle-1', eventKind: 'OBLIGATION', payload: { obligationId: 'circle-1:0:member-1', outcome: 'ON_TIME' } }).verified, true);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('allows an exact immutable evidence retry but rejects a conflicting record for the same transaction', () => {
  const store = new ContributionEvidenceStore();
  try {
    const first = record(store);
    assert.deepEqual(record(store), first);
    assert.throws(() => record(store, { memberId: 'different-member' }), /Conflicting verified evidence/);
    assert.equal(store.verifyReference({
      evidenceRef: first.evidenceRef, memberId: 'member-1', circleId: 'circle-1',
      eventKind: 'OBLIGATION',
      payload: { obligationId: 'circle-1:0:member-1', outcome: 'ON_TIME' },
    }).verified, true);
  } finally { store.close(); }
});

test('rejects wrong circle, member, round, payload, unverified proof and duplicate transaction', () => {
  const store = new ContributionEvidenceStore();
  try {
    const accepted = record(store);
    assert.equal(store.verifyReference({ evidenceRef: accepted.evidenceRef, memberId: 'attacker', circleId: 'circle-1', eventKind: 'OBLIGATION', payload: { obligationId: 'circle-1:0:member-1', outcome: 'ON_TIME' } }).verified, false);
    assert.equal(store.verifyReference({ evidenceRef: accepted.evidenceRef, memberId: 'member-1', circleId: 'other', eventKind: 'OBLIGATION', payload: { obligationId: 'circle-1:0:member-1', outcome: 'ON_TIME' } }).verified, false);
    assert.equal(store.verifyReference({ evidenceRef: accepted.evidenceRef, memberId: 'member-1', circleId: 'circle-1', eventKind: 'OBLIGATION', payload: { obligationId: 'circle-1:1:member-1', outcome: 'ON_TIME' } }).verified, false);
    assert.deepEqual(record(store), accepted);
    assert.throws(() => record(store, { binding: { ...binding, round: 1 } }), /binding/);
    assert.throws(() => record(store, { evidence: { ...evidence, verified: false } }), /Verified on-time/);
  } finally { store.close(); }
});
