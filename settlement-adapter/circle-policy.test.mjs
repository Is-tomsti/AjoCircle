import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDefaultCase,
  assessPrivatePayout,
  calculatePublicProportionalDistribution,
  calculateRemovalSettlement,
  validateCirclePolicy,
} from './circle-policy.mjs';

const DAY = 86_400_000;
const deadlineMs = 2_000_000_000_000;

test('validates the two circle modes and keeps private circles invite-only', () => {
  assert.deepEqual(validateCirclePolicy({ mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 }), {
    mode: 'PROTECTED_PUBLIC', publiclyDiscoverable: true, invitationOnly: false,
    gracePeriodDays: 5, shortfallPolicy: 'WAIT_FOR_FULL_POT', penaltyBps: 500,
    distributionPolicy: 'PROPORTIONAL_VERIFIED_CONTRIBUTIONS',
  });
  assert.deepEqual(validateCirclePolicy({ mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 }), {
    mode: 'PRIVATE_TRUSTED', publiclyDiscoverable: false, invitationOnly: true,
    gracePeriodDays: 5, shortfallPolicy: 'WAIT_FOR_FULL_POT', penaltyBps: 0,
    distributionPolicy: 'ROTATING_ROUND_RECIPIENT',
  });
  assert.throws(() => validateCirclePolicy({ mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5, publiclyDiscoverable: true }), /cannot be publicly discoverable/);
  assert.throws(() => validateCirclePolicy({ mode: 'PROTECTED_PUBLIC', gracePeriodDays: 0 }), /gracePeriodDays/);
  assert.throws(() => validateCirclePolicy({ mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5, penaltyBps: 500 }), /cannot use the platform removal penalty/);
  assert.throws(() => validateCirclePolicy({ mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5, penaltyBps: 400 }), /penaltyBps/);
  assert.throws(() => validateCirclePolicy({ mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5, shortfallPolicy: 'ALLOW_PARTIAL_PAYOUT' }), /must wait for the full pot/);
});

test('default is not due before deadline and grace period includes its exact boundary', () => {
  assert.equal(assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs - 1 }).status, 'NOT_DUE');
  assert.equal(assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs + 1 }).status, 'GRACE_PERIOD');
  const atBoundary = assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs + 5 * DAY });
  assert.equal(atBoundary.status, 'GRACE_PERIOD');
  assert.equal(atBoundary.eligibleForVote, false);
  assert.equal(assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs + 5 * DAY + 1 }).status, 'ELIGIBLE_FOR_VOTE');
});

test('cured defaults and open hardship/dispute reviews block removal-vote eligibility', () => {
  assert.equal(assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs + 9 * DAY, isCured: true }).status, 'CURED');
  assert.equal(assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs + 9 * DAY, reviewStatus: 'OPEN' }).status, 'REVIEW_PENDING');
  assert.equal(assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs + 9 * DAY, reviewStatus: 'DISPUTED' }).status, 'DISPUTE_PENDING');
  assert.throws(() => assessDefaultCase({ deadlineMs, gracePeriodDays: 5, nowMs: deadlineMs, reviewStatus: 'UNKNOWN' }), /unsupported reviewStatus/);
});

test('5% penalty is based on balance after valid obligations, with integer base units', () => {
  const result = calculateRemovalSettlement({
    grossRefundableBalance: '100000', validObligations: '20000',
    voteStatus: 'APPROVED', reviewStatus: 'CLEARED',
  });
  assert.deepEqual(result, {
    grossRefundableBalance: '100000', validObligations: '20000',
    eligibleRefundableBalance: '80000', penaltyBps: 500,
    penaltyAmount: '4000', memberRefund: '76000', treasuryCreditPending: '4000',
    transferAuthorized: false,
  });
});

test('removal settlement blocks unapproved votes and unresolved hardship/disputes', () => {
  const base = { grossRefundableBalance: '1000', validObligations: '0' };
  assert.throws(() => calculateRemovalSettlement({ ...base, voteStatus: 'NOT_HELD', reviewStatus: 'CLEARED' }), /approved removal vote/);
  assert.throws(() => calculateRemovalSettlement({ ...base, voteStatus: 'APPROVED', reviewStatus: 'OPEN' }), /must be cleared first/);
  assert.throws(() => calculateRemovalSettlement({ ...base, voteStatus: 'APPROVED', reviewStatus: 'DISPUTED' }), /must be cleared first/);
});

test('refund calculation floors safely and never creates a negative refund', () => {
  const tiny = calculateRemovalSettlement({ grossRefundableBalance: '19', validObligations: '0', voteStatus: 'APPROVED', reviewStatus: 'CLEARED' });
  assert.equal(tiny.penaltyAmount, '0');
  assert.equal(tiny.memberRefund, '19');
  const overcommitted = calculateRemovalSettlement({ grossRefundableBalance: '100', validObligations: '150', voteStatus: 'APPROVED', reviewStatus: 'CLEARED' });
  assert.equal(overcommitted.eligibleRefundableBalance, '0');
  assert.equal(overcommitted.penaltyAmount, '0');
  assert.equal(overcommitted.memberRefund, '0');
  assert.throws(() => calculateRemovalSettlement({ grossRefundableBalance: '-1', validObligations: '0', voteStatus: 'APPROVED', reviewStatus: 'CLEARED' }), /base-unit string/);
});

test('private circle waits for the full pot by default and reports the exact shortfall', () => {
  assert.deepEqual(assessPrivatePayout({ expectedPot: '100', collectedAmount: '80' }), {
    status: 'UNDERFUNDED_WAITING', expectedPot: '100', collectedAmount: '80',
    shortfall: '20', proposedPayout: '0', transferAuthorized: false,
  });
  assert.equal(assessPrivatePayout({ expectedPot: '100', collectedAmount: '100' }).status, 'READY_FULL_POT');
});

test('private circle permits only an explicitly configured partial payout proposal', () => {
  const result = assessPrivatePayout({ expectedPot: '100', collectedAmount: '80', shortfallPolicy: 'ALLOW_PARTIAL_PAYOUT' });
  assert.equal(result.status, 'READY_PARTIAL_POT');
  assert.equal(result.proposedPayout, '80');
  assert.equal(result.shortfall, '20');
  assert.equal(result.transferAuthorized, false);
  assert.throws(() => assessPrivatePayout({ expectedPot: '100', collectedAmount: '101' }), /cannot exceed/);
  assert.throws(() => assessPrivatePayout({ expectedPot: '0', collectedAmount: '0' }), /greater than zero/);
});


test('public circle distributes the final pool in proportion to verified eligible contributions', () => {
  const result = calculatePublicProportionalDistribution({
    distributablePool: '1000',
    eligibleMembers: [
      { memberId: 'member-b', verifiedContributionAmount: '200' },
      { memberId: 'member-a', verifiedContributionAmount: '100' },
    ],
  });
  assert.deepEqual(result, {
    distributablePool: '1000',
    totalVerifiedEligibleContributions: '300',
    allocations: [
      { memberId: 'member-a', verifiedContributionAmount: '100', payoutAmount: '333' },
      { memberId: 'member-b', verifiedContributionAmount: '200', payoutAmount: '667' },
    ],
    transferAuthorized: false,
  });
  assert.equal(result.allocations.reduce((sum, item) => sum + BigInt(item.payoutAmount), 0n).toString(), '1000');
});

test('public distribution allocates rounding remainders deterministically and rejects duplicate or invalid weights', () => {
  const result = calculatePublicProportionalDistribution({
    distributablePool: '2',
    eligibleMembers: [
      { memberId: 'member-b', verifiedContributionAmount: '1' },
      { memberId: 'member-a', verifiedContributionAmount: '1' },
      { memberId: 'member-c', verifiedContributionAmount: '1' },
    ],
  });
  assert.deepEqual(result.allocations, [
    { memberId: 'member-a', verifiedContributionAmount: '1', payoutAmount: '1' },
    { memberId: 'member-b', verifiedContributionAmount: '1', payoutAmount: '1' },
    { memberId: 'member-c', verifiedContributionAmount: '1', payoutAmount: '0' },
  ]);
  assert.throws(() => calculatePublicProportionalDistribution({ distributablePool: '10', eligibleMembers: [] }), /non-empty array/);
  assert.throws(() => calculatePublicProportionalDistribution({ distributablePool: '10', eligibleMembers: [
    { memberId: 'member-a', verifiedContributionAmount: '1' },
    { memberId: 'member-a', verifiedContributionAmount: '2' },
  ] }), /unique/);
  assert.throws(() => calculatePublicProportionalDistribution({ distributablePool: '10', eligibleMembers: [
    { memberId: 'member-a', verifiedContributionAmount: '0' },
  ] }), /positive verified contribution/);
});
