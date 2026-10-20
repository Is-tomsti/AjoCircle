import { positiveAmount } from './status-values.mjs';

const REQUIRED_VIEWS = ['getRound', 'getContribution', 'isCircleCompleted', 'isPayoutPending', 'isPayoutComplete'];

export async function getMemberContributionStatus({ store, contractClient, intentId } = {}) {
  if (!store || typeof store.getIntent !== 'function') throw new Error('A trusted settlement store is required');
  if (!contractClient || REQUIRED_VIEWS.some(name => typeof contractClient[name] !== 'function')) throw new Error('A contract read client with contribution and round views is required');
  if (typeof intentId !== 'string' || !intentId.trim()) throw new Error('A stored intent ID is required');
  const intent = store.getIntent(intentId.trim());
  if (!intent) throw new Error('Stored contribution intent was not found');
  if (typeof intent.requiredContributionAmount !== 'string') throw new Error('Stored intent has no trusted native-NEAR contribution amount');

  const [round, contribution, circleCompleted, payoutPending, payoutComplete] = await Promise.all([
    contractClient.getRound(),
    contractClient.getContribution({ member: intent.memberId }),
    contractClient.isCircleCompleted(),
    contractClient.isPayoutPending(),
    contractClient.isPayoutComplete(),
  ]);
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('Contract round must be a non-negative safe integer');
  if (typeof circleCompleted !== 'boolean' || typeof payoutPending !== 'boolean' || typeof payoutComplete !== 'boolean') throw new Error('Contract read client returned malformed state flags');

  let contractStatus;
  let contributionAmount;
  if (circleCompleted) contractStatus = 'CIRCLE_COMPLETED';
  else if (round !== intent.round) contractStatus = 'ROUND_MISMATCH';
  else if (contribution === null || contribution === undefined) contractStatus = 'NO_CONTRIBUTION';
  else {
    contributionAmount = positiveAmount(contribution, 'on-chain contribution');
    contractStatus = BigInt(contributionAmount) === BigInt(intent.requiredContributionAmount) ? 'CONTRIBUTION_CONFIRMED' : 'AMOUNT_MISMATCH';
  }

  const swapStatus = intent.status === 'VERIFIED_DELIVERY' ? 'SWAP_DELIVERED' : 'AWAITING_SWAP_DELIVERY';
  let nextAction;
  if (contractStatus === 'CONTRIBUTION_CONFIRMED') nextAction = payoutPending ? 'PAYOUT_PENDING' : payoutComplete ? 'PAYOUT_COMPLETE' : 'CONTRIBUTION_CONFIRMED';
  else if (contractStatus === 'ROUND_MISMATCH') nextAction = 'CHECK_CURRENT_ROUND';
  else if (contractStatus === 'AMOUNT_MISMATCH') nextAction = 'MANUAL_REVIEW_REQUIRED';
  else if (contractStatus === 'CIRCLE_COMPLETED') nextAction = 'CIRCLE_COMPLETED';
  else if (swapStatus === 'SWAP_DELIVERED') nextAction = 'UNWRAP_AND_SUBMIT_NATIVE_NEAR_CONTRIBUTION';
  else nextAction = 'WAIT_FOR_SWAP_SETTLEMENT';

  return Object.freeze({ intentId: intent.intentId, circleId: intent.circleId, memberId: intent.memberId, intentRound: intent.round, contractRound: round, swapStatus, contractStatus, contributionAmount, requiredContributionAmount: intent.requiredContributionAmount, payoutPending, payoutComplete, circleCompleted, nextAction });
}
