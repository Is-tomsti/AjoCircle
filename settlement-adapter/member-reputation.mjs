const OUTCOMES = new Set(['ON_TIME', 'LATE', 'CURED_DEFAULT', 'MISSED', 'CONFIRMED_DEFAULT']);
const PAID_OUTCOMES = new Set(['ON_TIME', 'LATE', 'CURED_DEFAULT']);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function uniqueVerifiedEvents(events, field) {
  if (!Array.isArray(events)) throw new Error(`${field} must be an array`);
  const ids = new Set();
  return events.filter(event => {
    if (!event || typeof event !== 'object') throw new Error(`${field} contains an invalid event`);
    if (event.verified !== true) return false;
    const id = requireText(event.eventId, `${field}.eventId`);
    if (ids.has(id)) throw new Error(`${field} contains duplicate eventId ${id}`);
    ids.add(id);
    // Open disputes remain visible in profile metadata but cannot affect scores.
    return event.disputed !== true && event.disputeStatus !== 'OPEN' && event.disputeStatus !== 'RESOLVED_REVERSED';
  });
}

/**
 * Builds dashboard metrics from authoritative, verified records only.
 * This function does not fetch or verify chain events; callers must supply
 * records verified by trusted contract/settlement adapters. Unverified events
 * are ignored. Each obligation is a canonical final outcome, not an event log.
 */
export function buildMemberReputationProfile({ obligations = [], circleEvents = [] } = {}) {
  const verifiedObligations = uniqueVerifiedEvents(obligations, 'obligations');
  const verifiedCircleEvents = uniqueVerifiedEvents(circleEvents, 'circleEvents');
  const disputedObligations = obligations.filter(event => event?.verified === true && (event.disputed === true || event.disputeStatus === 'OPEN')).length;
  const disputedCircleEvents = circleEvents.filter(event => event?.verified === true && (event.disputed === true || event.disputeStatus === 'OPEN')).length;
  const obligationIds = new Set();
  const counts = { onTimePayments: 0, latePayments: 0, curedDefaults: 0, missedPayments: 0, confirmedDefaults: 0 };

  for (const obligation of verifiedObligations) {
    const obligationId = requireText(obligation.obligationId, 'obligationId');
    if (obligationIds.has(obligationId)) throw new Error(`duplicate obligationId ${obligationId}`);
    obligationIds.add(obligationId);
    if (!OUTCOMES.has(obligation.outcome)) throw new Error(`unsupported outcome for obligation ${obligationId}`);
    if (obligation.outcome === 'ON_TIME') counts.onTimePayments += 1;
    if (obligation.outcome === 'LATE') counts.latePayments += 1;
    if (obligation.outcome === 'CURED_DEFAULT') {
      counts.latePayments += 1;
      counts.curedDefaults += 1;
    }
    if (obligation.outcome === 'MISSED') counts.missedPayments += 1;
    if (obligation.outcome === 'CONFIRMED_DEFAULT') counts.confirmedDefaults += 1;
  }

  const scheduledPayments = verifiedObligations.length;
  const paymentsMade = counts.onTimePayments + counts.latePayments;
  const scoredOutcomes = scheduledPayments;
  const weightedScore = counts.onTimePayments * 2 + counts.latePayments;
  const trustScore = scoredOutcomes === 0 ? 500 : Math.min(1000, Math.floor(weightedScore * 500 / scoredOutcomes));
  const paidRateBps = scheduledPayments === 0 ? null : Math.floor(paymentsMade * 10_000 / scheduledPayments);
  const onTimeRateBps = scheduledPayments === 0 ? null : Math.floor(counts.onTimePayments * 10_000 / scheduledPayments);

  const uniqueRounds = new Set();
  const uniqueWonRounds = new Set();
  const uniqueCompletedCircles = new Set();
  for (const event of verifiedCircleEvents) {
    if (!['ROUND_COMPLETED', 'POT_RECEIVED', 'CIRCLE_COMPLETED'].includes(event.type)) {
      throw new Error(`unsupported circle event type ${String(event.type)}`);
    }
    const circleId = requireText(event.circleId, 'circleId');
    if (event.type === 'ROUND_COMPLETED') {
      if (!Number.isSafeInteger(event.round) || event.round < 0) throw new Error('round must be a non-negative safe integer');
      uniqueRounds.add(`${circleId}:${event.round}`);
    }
    if (event.type === 'POT_RECEIVED') {
      if (!Number.isSafeInteger(event.round) || event.round < 0) throw new Error('round must be a non-negative safe integer');
      uniqueWonRounds.add(`${circleId}:${event.round}`);
    }
    if (event.type === 'CIRCLE_COMPLETED') uniqueCompletedCircles.add(circleId);
  }

  return Object.freeze({
    scoreVersion: 'ajo-trust-v1',
    trustScore,
    scheduledPayments,
    paymentsMade,
    paymentRateBps: paidRateBps,
    onTimePaymentRateBps: onTimeRateBps,
    completedRounds: uniqueRounds.size,
    roundsWon: uniqueWonRounds.size,
    completedCircles: uniqueCompletedCircles.size,
    ...counts,
    disputedObligations,
    disputedCircleEvents,
    verifiedOnly: true,
    scoreIsGuarantee: false,
  });
}
