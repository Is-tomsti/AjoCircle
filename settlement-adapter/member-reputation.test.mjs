import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberReputationProfile } from './member-reputation.mjs';

test('builds payment and trust metrics from verified canonical obligation outcomes', () => {
  const profile = buildMemberReputationProfile({
    obligations: [
      { eventId: 'e1', obligationId: 'o1', outcome: 'ON_TIME', verified: true },
      { eventId: 'e2', obligationId: 'o2', outcome: 'LATE', verified: true },
      { eventId: 'e3', obligationId: 'o3', outcome: 'CURED_DEFAULT', verified: true },
      { eventId: 'e4', obligationId: 'o4', outcome: 'MISSED', verified: true },
      { eventId: 'e5', obligationId: 'o5', outcome: 'CONFIRMED_DEFAULT', verified: true },
      { eventId: 'fake', obligationId: 'o6', outcome: 'ON_TIME', verified: false },
    ],
  });
  assert.equal(profile.scheduledPayments, 5);
  assert.equal(profile.paymentsMade, 3);
  assert.equal(profile.paymentRateBps, 6000);
  assert.equal(profile.onTimePaymentRateBps, 2000);
  assert.equal(profile.onTimePayments, 1);
  assert.equal(profile.latePayments, 2);
  assert.equal(profile.curedDefaults, 1);
  assert.equal(profile.missedPayments, 1);
  assert.equal(profile.confirmedDefaults, 1);
  assert.equal(profile.trustScore, 400);
  assert.equal(profile.verifiedOnly, true);
  assert.equal(profile.scoreIsGuarantee, false);
});

test('empty verified history has neutral score and undefined rates', () => {
  const profile = buildMemberReputationProfile();
  assert.equal(profile.trustScore, 500);
  assert.equal(profile.paymentRateBps, null);
  assert.equal(profile.onTimePaymentRateBps, null);
  assert.equal(profile.scheduledPayments, 0);
});

test('counts completed rounds, pots won, and completed circles once each', () => {
  const profile = buildMemberReputationProfile({ circleEvents: [
    { eventId: 'r1', type: 'ROUND_COMPLETED', circleId: 'circle-a', round: 1, verified: true },
    { eventId: 'r2', type: 'ROUND_COMPLETED', circleId: 'circle-a', round: 1, verified: true },
    { eventId: 'w1', type: 'POT_RECEIVED', circleId: 'circle-a', round: 1, verified: true },
    { eventId: 'w2', type: 'POT_RECEIVED', circleId: 'circle-a', round: 2, verified: true },
    { eventId: 'c1', type: 'CIRCLE_COMPLETED', circleId: 'circle-a', verified: true },
    { eventId: 'c2', type: 'CIRCLE_COMPLETED', circleId: 'circle-a', verified: true },
    { eventId: 'fake', type: 'CIRCLE_COMPLETED', circleId: 'circle-b', verified: false },
  ] });
  assert.equal(profile.completedRounds, 1);
  assert.equal(profile.roundsWon, 2);
  assert.equal(profile.completedCircles, 1);
});

test('rejects duplicate event IDs and duplicate canonical obligation IDs', () => {
  assert.throws(() => buildMemberReputationProfile({ obligations: [
    { eventId: 'same', obligationId: 'o1', outcome: 'ON_TIME', verified: true },
    { eventId: 'same', obligationId: 'o2', outcome: 'LATE', verified: true },
  ] }), /duplicate eventId/);
  assert.throws(() => buildMemberReputationProfile({ obligations: [
    { eventId: 'e1', obligationId: 'same', outcome: 'ON_TIME', verified: true },
    { eventId: 'e2', obligationId: 'same', outcome: 'LATE', verified: true },
  ] }), /duplicate obligationId/);
});

test('rejects unsupported outcomes and malformed round events', () => {
  assert.throws(() => buildMemberReputationProfile({ obligations: [
    { eventId: 'e1', obligationId: 'o1', outcome: 'UNKNOWN', verified: true },
  ] }), /unsupported outcome/);
  assert.throws(() => buildMemberReputationProfile({ circleEvents: [
    { eventId: 'e1', type: 'ROUND_COMPLETED', circleId: 'circle-a', round: -1, verified: true },
  ] }), /round/);
});


test('open disputes are surfaced but excluded from trust and circle metrics', () => {
  const profile = buildMemberReputationProfile({
    obligations: [
      { eventId: 'ok-1', obligationId: 'o1', outcome: 'ON_TIME', verified: true },
      { eventId: 'disputed-1', obligationId: 'o2', outcome: 'CONFIRMED_DEFAULT', verified: true, disputeStatus: 'OPEN' },
      { eventId: 'disputed-2', obligationId: 'o3', outcome: 'MISSED', verified: true, disputed: true },
    ],
    circleEvents: [
      { eventId: 'circle-dispute', type: 'CIRCLE_COMPLETED', circleId: 'circle-x', verified: true, disputeStatus: 'OPEN' },
    ],
  });
  assert.equal(profile.scheduledPayments, 1);
  assert.equal(profile.confirmedDefaults, 0);
  assert.equal(profile.missedPayments, 0);
  assert.equal(profile.trustScore, 1000);
  assert.equal(profile.disputedObligations, 2);
  assert.equal(profile.completedCircles, 0);
  assert.equal(profile.disputedCircleEvents, 1);
});
