const DAY_MS = 86_400_000;
const MODES = new Set(['PROTECTED_PUBLIC', 'PRIVATE_TRUSTED']);
const SHORTFALL_POLICIES = new Set(['WAIT_FOR_FULL_POT', 'ALLOW_PARTIAL_PAYOUT']);
const REVIEW_STATES = new Set(['NONE', 'OPEN', 'CLEARED', 'DISPUTED']);
const VOTE_STATES = new Set(['NOT_HELD', 'REJECTED', 'APPROVED']);
const UINT_RE = /^(0|[1-9][0-9]*)$/;

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a safe integer from ${min} to ${max}`);
  }
  return value;
}

function baseUnits(value, field) {
  if (typeof value !== 'string' || !UINT_RE.test(value)) {
    throw new Error(`${field} must be a non-negative integer base-unit string`);
  }
  return BigInt(value);
}

/**
 * Validates product-level policy only. It does not deploy a contract, transfer
 * funds, validate a real vote, or replace an authoritative event ledger.
 */
export function validateCirclePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('policy is required');
  if (!MODES.has(policy.mode)) throw new Error('mode must be PROTECTED_PUBLIC or PRIVATE_TRUSTED');
  const gracePeriodDays = integer(policy.gracePeriodDays, 'gracePeriodDays', { min: 1, max: 30 });
  const shortfallPolicy = policy.shortfallPolicy ?? 'WAIT_FOR_FULL_POT';
  if (!SHORTFALL_POLICIES.has(shortfallPolicy)) throw new Error('unsupported shortfallPolicy');
  if (policy.mode === 'PROTECTED_PUBLIC' && shortfallPolicy !== 'WAIT_FOR_FULL_POT') {
    throw new Error('PROTECTED_PUBLIC circles must wait for the full pot');
  }
  if (policy.mode === 'PRIVATE_TRUSTED' && policy.publiclyDiscoverable === true) {
    throw new Error('PRIVATE_TRUSTED circles cannot be publicly discoverable');
  }
  if (policy.mode === 'PROTECTED_PUBLIC' && policy.publiclyDiscoverable === false) {
    throw new Error('PROTECTED_PUBLIC circles must be discoverable');
  }
  if (policy.mode === 'PRIVATE_TRUSTED' && policy.penaltyBps !== undefined && policy.penaltyBps !== 0) {
    throw new Error('PRIVATE_TRUSTED circles cannot use the platform removal penalty');
  }
  const penaltyBps = policy.mode === 'PROTECTED_PUBLIC'
    ? integer(policy.penaltyBps ?? 500, 'penaltyBps', { min: 500, max: 500 })
    : 0;
  const distributionPolicy = policy.mode === 'PROTECTED_PUBLIC'
    ? 'PROPORTIONAL_VERIFIED_CONTRIBUTIONS'
    : 'ROTATING_ROUND_RECIPIENT';
  return Object.freeze({
    mode: policy.mode,
    publiclyDiscoverable: policy.mode === 'PROTECTED_PUBLIC',
    invitationOnly: policy.mode === 'PRIVATE_TRUSTED',
    gracePeriodDays,
    shortfallPolicy,
    penaltyBps,
    distributionPolicy,
  });
}

/**
 * Pure default timeline. Removal is never automatic: an expired grace period
 * makes a case eligible for a vote, unless cured or a review/dispute is open.
 */
export function assessDefaultCase({ deadlineMs, gracePeriodDays, nowMs, isCured = false, reviewStatus = 'NONE' }) {
  integer(deadlineMs, 'deadlineMs', { min: 1 });
  integer(nowMs, 'nowMs', { min: 0 });
  integer(gracePeriodDays, 'gracePeriodDays', { min: 1, max: 30 });
  if (typeof isCured !== 'boolean') throw new Error('isCured must be a boolean');
  if (!REVIEW_STATES.has(reviewStatus)) throw new Error('unsupported reviewStatus');
  if (isCured) return Object.freeze({ status: 'CURED', graceEndsAtMs: deadlineMs + gracePeriodDays * DAY_MS, eligibleForVote: false });
  const graceEndsAtMs = deadlineMs + gracePeriodDays * DAY_MS;
  if (nowMs <= deadlineMs) return Object.freeze({ status: 'NOT_DUE', graceEndsAtMs, eligibleForVote: false });
  if (nowMs <= graceEndsAtMs) return Object.freeze({ status: 'GRACE_PERIOD', graceEndsAtMs, eligibleForVote: false });
  if (reviewStatus === 'OPEN' || reviewStatus === 'DISPUTED') {
    return Object.freeze({ status: reviewStatus === 'DISPUTED' ? 'DISPUTE_PENDING' : 'REVIEW_PENDING', graceEndsAtMs, eligibleForVote: false });
  }
  return Object.freeze({ status: 'ELIGIBLE_FOR_VOTE', graceEndsAtMs, eligibleForVote: true });
}

/**
 * Calculates a proposed refund/penalty only after a validated removal vote and
 * cleared review. Amounts are integer base units; no money is moved here.
 */
export function calculateRemovalSettlement({ grossRefundableBalance, validObligations, voteStatus, reviewStatus, penaltyBps = 500 }) {
  if (!VOTE_STATES.has(voteStatus)) throw new Error('unsupported voteStatus');
  if (!REVIEW_STATES.has(reviewStatus)) throw new Error('unsupported reviewStatus');
  if (voteStatus !== 'APPROVED') throw new Error('a valid approved removal vote is required');
  if (reviewStatus !== 'CLEARED') throw new Error('hardship review and disputes must be cleared first');
  integer(penaltyBps, 'penaltyBps', { min: 0, max: 1000 });
  const gross = baseUnits(grossRefundableBalance, 'grossRefundableBalance');
  const obligations = baseUnits(validObligations, 'validObligations');
  const eligibleRefundableBalance = gross > obligations ? gross - obligations : 0n;
  const penaltyAmount = eligibleRefundableBalance * BigInt(penaltyBps) / 10_000n;
  const memberRefund = eligibleRefundableBalance - penaltyAmount;
  return Object.freeze({
    grossRefundableBalance: gross.toString(),
    validObligations: obligations.toString(),
    eligibleRefundableBalance: eligibleRefundableBalance.toString(),
    penaltyBps,
    penaltyAmount: penaltyAmount.toString(),
    memberRefund: memberRefund.toString(),
    treasuryCreditPending: penaltyAmount.toString(),
    transferAuthorized: false,
  });
}

/**
 * Private-circle payout check. A partial payout is returned as a proposal only
 * when the members explicitly configured ALLOW_PARTIAL_PAYOUT.
 */
export function assessPrivatePayout({ expectedPot, collectedAmount, shortfallPolicy = 'WAIT_FOR_FULL_POT' }) {
  const expected = baseUnits(expectedPot, 'expectedPot');
  const collected = baseUnits(collectedAmount, 'collectedAmount');
  if (expected <= 0n) throw new Error('expectedPot must be greater than zero');
  if (collected > expected) throw new Error('collectedAmount cannot exceed expectedPot');
  if (!SHORTFALL_POLICIES.has(shortfallPolicy)) throw new Error('unsupported shortfallPolicy');
  const shortfall = expected - collected;
  if (shortfall === 0n) return Object.freeze({ status: 'READY_FULL_POT', expectedPot: expected.toString(), collectedAmount: collected.toString(), shortfall: '0', proposedPayout: collected.toString(), transferAuthorized: false });
  if (shortfallPolicy === 'ALLOW_PARTIAL_PAYOUT' && collected > 0n) {
    return Object.freeze({ status: 'READY_PARTIAL_POT', expectedPot: expected.toString(), collectedAmount: collected.toString(), shortfall: shortfall.toString(), proposedPayout: collected.toString(), transferAuthorized: false });
  }
  return Object.freeze({ status: 'UNDERFUNDED_WAITING', expectedPot: expected.toString(), collectedAmount: collected.toString(), shortfall: shortfall.toString(), proposedPayout: '0', transferAuthorized: false });
}


/**
 * Proposes a public-circle distribution in proportion to verified eligible
 * contribution totals. The pool must already be reconciled by the caller.
 * Uses largest-remainder rounding with account ID as the stable tie-breaker.
 * This calculation does not authorize or execute transfers.
 */
export function calculatePublicProportionalDistribution({ distributablePool, eligibleMembers }) {
  const pool = baseUnits(distributablePool, 'distributablePool');
  if (!Array.isArray(eligibleMembers) || eligibleMembers.length === 0) {
    throw new Error('eligibleMembers must be a non-empty array');
  }

  const seen = new Set();
  const members = eligibleMembers.map((member, index) => {
    if (!member || typeof member.memberId !== 'string' || member.memberId.trim() === '') {
      throw new Error(`eligibleMembers[${index}].memberId must be a non-empty string`);
    }
    if (seen.has(member.memberId)) throw new Error('eligible member IDs must be unique');
    seen.add(member.memberId);
    const contribution = baseUnits(member.verifiedContributionAmount, `eligibleMembers[${index}].verifiedContributionAmount`);
    if (contribution === 0n) throw new Error('eligible members must have a positive verified contribution total');
    return { memberId: member.memberId, contribution, share: 0n, remainder: 0n };
  });

  const totalWeight = members.reduce((sum, member) => sum + member.contribution, 0n);
  let allocated = 0n;
  for (const member of members) {
    const numerator = pool * member.contribution;
    member.share = numerator / totalWeight;
    member.remainder = numerator % totalWeight;
    allocated += member.share;
  }

  let remaining = pool - allocated;
  const remainderOrder = [...members].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
  });
  for (let i = 0; remaining > 0n; i += 1) {
    remainderOrder[i].share += 1n;
    remaining -= 1n;
  }

  const allocations = members
    .map(({ memberId, contribution, share }) => ({
      memberId,
      verifiedContributionAmount: contribution.toString(),
      payoutAmount: share.toString(),
    }))
    .sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);

  return Object.freeze({
    distributablePool: pool.toString(),
    totalVerifiedEligibleContributions: totalWeight.toString(),
    allocations: Object.freeze(allocations.map(Object.freeze)),
    transferAuthorized: false,
  });
}
