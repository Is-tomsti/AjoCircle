import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemberReputationStore } from './member-reputation-store.mjs';

function createStore(path = ':memory:', { allowReviewer = true } = {}) {
  return new MemberReputationStore({
    path,
    verifyEvidence: ({ evidenceRef }) => evidenceRef.startsWith('chain:')
      ? { verified: true, digest: `sha256:${evidenceRef}` }
      : { verified: false },
    authorizeReviewer: ({ reviewerId }) => allowReviewer && reviewerId === 'trusted-reviewer',
  });
}

function addDefault(store, overrides = {}) {
  return store.appendVerifiedEvent({
    eventId: 'e1', memberId: 'm1', circleId: 'c1', eventKind: 'OBLIGATION',
    payload: { obligationId: 'o1', outcome: 'CONFIRMED_DEFAULT', disputed: true, disputeStatus: 'OPEN', verified: false },
    evidenceRef: 'chain:tx-1', ...overrides,
  });
}

test('requires trusted evidence and reviewer callbacks; rejects unverified evidence', () => {
  assert.throws(() => new MemberReputationStore(), /trusted verifyEvidence/);
  assert.throws(() => new MemberReputationStore({ verifyEvidence: () => ({ verified: true, digest: 'x' }) }), /authorizeReviewer/);
  const store = createStore();
  try {
    assert.throws(() => store.appendVerifiedEvent({ eventId: 'e1', memberId: 'm1', circleId: 'c1', eventKind: 'OBLIGATION', payload: { obligationId: 'o1', outcome: 'ON_TIME' }, evidenceRef: 'user:claim' }), /did not pass trusted verification/);
  } finally { store.close(); }
});

test('canonicalizes event payload so caller flags cannot forge verification or dispute state', () => {
  const store = createStore();
  try {
    addDefault(store);
    const profile = store.getMemberProfile({ memberId: 'm1' });
    assert.equal(profile.confirmedDefaults, 1);
    assert.equal(profile.disputedObligations, 0);
  } finally { store.close(); }
});

test('blocks duplicate event IDs and evidence refs and scores only trusted records', () => {
  const store = createStore();
  try {
    store.appendVerifiedEvent({ eventId: 'e1', memberId: 'm1', circleId: 'c1', eventKind: 'OBLIGATION', payload: { obligationId: 'o1', outcome: 'ON_TIME' }, evidenceRef: 'chain:tx-1' });
    assert.throws(() => store.appendVerifiedEvent({ eventId: 'e1', memberId: 'm1', circleId: 'c1', eventKind: 'OBLIGATION', payload: { obligationId: 'o2', outcome: 'LATE' }, evidenceRef: 'chain:tx-2' }), /UNIQUE constraint/);
    assert.throws(() => store.appendVerifiedEvent({ eventId: 'e2', memberId: 'm1', circleId: 'c1', eventKind: 'OBLIGATION', payload: { obligationId: 'o2', outcome: 'LATE' }, evidenceRef: 'chain:tx-1' }), /UNIQUE constraint/);
    assert.equal(store.getMemberProfile({ memberId: 'm1' }).trustScore, 1000);
  } finally { store.close(); }
});

test('requires an authorized reviewer and prevents reopening resolved disputes', () => {
  const store = createStore();
  try {
    addDefault(store);
    store.openDispute({ eventId: 'e1', reason: 'Member requested review' });
    assert.throws(() => store.resolveDispute({ eventId: 'e1', decision: 'RESOLVED_UPHELD', reason: 'Evidence confirmed', reviewerId: 'untrusted' }), /not authorized/);
    store.resolveDispute({ eventId: 'e1', decision: 'RESOLVED_UPHELD', reason: 'Evidence confirmed', reviewerId: 'trusted-reviewer' });
    assert.throws(() => store.openDispute({ eventId: 'e1', reason: 'Try to reopen' }), /already exists/);
  } finally { store.close(); }
});

test('open disputes are visible but excluded; upheld disputes score and reversed events stay excluded', () => {
  const store = createStore();
  try {
    addDefault(store);
    store.openDispute({ eventId: 'e1', reason: 'Member requested review' });
    let profile = store.getMemberProfile({ memberId: 'm1' });
    assert.equal(profile.scheduledPayments, 0);
    assert.equal(profile.disputedObligations, 1);
    store.resolveDispute({ eventId: 'e1', decision: 'RESOLVED_UPHELD', reason: 'Evidence confirmed', reviewerId: 'trusted-reviewer' });
    profile = store.getMemberProfile({ memberId: 'm1' });
    assert.equal(profile.confirmedDefaults, 1);
    assert.throws(() => store.openDispute({ eventId: 'e1', reason: 'Correction review' }), /already exists/);
  } finally { store.close(); }

  const reversedStore = createStore();
  try {
    addDefault(reversedStore);
    reversedStore.openDispute({ eventId: 'e1', reason: 'Correction review' });
    reversedStore.resolveDispute({ eventId: 'e1', decision: 'RESOLVED_REVERSED', reason: 'Original event invalidated', reviewerId: 'trusted-reviewer' });
    assert.equal(reversedStore.getMemberProfile({ memberId: 'm1' }).scheduledPayments, 0);
  } finally { reversedStore.close(); }
});

test('events and dispute decisions survive closing and reopening the SQLite database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ajo-reputation-'));
  const path = join(dir, 'reputation.sqlite');
  try {
    let store = createStore(path);
    addDefault(store);
    store.openDispute({ eventId: 'e1', reason: 'Persistence test' });
    store.close();

    store = createStore(path);
    try {
      const profile = store.getMemberProfile({ memberId: 'm1' });
      assert.equal(profile.scheduledPayments, 0);
      assert.equal(profile.disputedObligations, 1);
      store.resolveDispute({ eventId: 'e1', decision: 'RESOLVED_UPHELD', reason: 'Review after restart', reviewerId: 'trusted-reviewer' });
    } finally { store.close(); }

    store = createStore(path);
    try {
      const profile = store.getMemberProfile({ memberId: 'm1' });
      assert.equal(profile.confirmedDefaults, 1);
      assert.equal(profile.disputedObligations, 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
