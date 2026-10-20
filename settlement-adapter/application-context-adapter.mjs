const REQUIRED_CONTEXT_FIELDS = [
  'circleStatus', 'memberStatus', 'roundStatus', 'memberNearAccount',
  'requiredContributionAmount', 'allowedOriginAssets', 'refundAddresses', 'maxInputAmounts',
];

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Adapt real application identity and authoritative repository methods to the
 * callbacks required by createMemberQuoteHandler(). This module intentionally
 * does not implement authentication or a database.
 *
 * repository.findMembershipForPrincipal({ principalId, circleId }) must query
 * authoritative membership data and return { circleId, memberId, status } or null.
 * repository.getMemberQuoteContext({ circleId, memberId, round }) must load a
 * consistent authoritative context snapshot, including all REQUIRED_CONTEXT_FIELDS.
 */
export function createApplicationContextResolvers({ repository, getPrincipalId } = {}) {
  if (!repository || typeof repository.findMembershipForPrincipal !== 'function'
      || typeof repository.getMemberQuoteContext !== 'function') {
    throw new Error('An authoritative membership/context repository is required');
  }
  if (typeof getPrincipalId !== 'function') {
    throw new Error('A trusted principal ID extractor is required');
  }

  async function resolveMemberIdentity({ principal, circleId } = {}) {
    if (!principal || !nonEmptyText(circleId)) return null;
    let principalId;
    try { principalId = await getPrincipalId(principal); }
    catch { return null; }
    if (!nonEmptyText(principalId)) return null;

    let membership;
    try {
      membership = await repository.findMembershipForPrincipal({
        principalId: principalId.trim(), circleId: circleId.trim(),
      });
    } catch {
      return null;
    }
    if (!membership || membership.circleId !== circleId.trim()
        || membership.status !== 'ACTIVE' || !nonEmptyText(membership.memberId)) return null;
    return membership.memberId.trim();
  }

  async function resolveTrustedContext({ circleId, memberId, round } = {}) {
    if (!nonEmptyText(circleId) || !nonEmptyText(memberId)
        || !Number.isSafeInteger(round) || round < 0) return null;

    let context;
    try {
      context = await repository.getMemberQuoteContext({
        circleId: circleId.trim(), memberId: memberId.trim(), round,
      });
    } catch {
      return null;
    }
    if (!context || context.circleId !== circleId.trim()
        || context.memberId !== memberId.trim() || context.round !== round) return null;
    if (REQUIRED_CONTEXT_FIELDS.some(field => !Object.hasOwn(context, field))) return null;

    // Return only the quote service's documented trusted fields, never arbitrary
    // repository properties or caller-controlled values.
    return Object.freeze({
      circleId: context.circleId,
      memberId: context.memberId,
      round: context.round,
      circleStatus: context.circleStatus,
      memberStatus: context.memberStatus,
      roundStatus: context.roundStatus,
      memberNearAccount: context.memberNearAccount,
      requiredContributionAmount: context.requiredContributionAmount,
      allowedOriginAssets: Array.isArray(context.allowedOriginAssets) ? [...context.allowedOriginAssets] : context.allowedOriginAssets,
      refundAddresses: context.refundAddresses && typeof context.refundAddresses === 'object'
        ? { ...context.refundAddresses } : context.refundAddresses,
      maxInputAmounts: context.maxInputAmounts && typeof context.maxInputAmounts === 'object'
        ? { ...context.maxInputAmounts } : context.maxInputAmounts,
    });
  }

  return Object.freeze({ resolveMemberIdentity, resolveTrustedContext });
}
