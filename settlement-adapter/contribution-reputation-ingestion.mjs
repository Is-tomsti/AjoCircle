import { verifyNearContributionEvidence } from './near-contribution-evidence.mjs';
import { verifyIndexedContributionRoundBinding } from './near-indexed-round-binding.mjs';

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}
function validRound(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('round must be a non-negative safe integer');
  return value;
}
function decimal(value, field) {
  const result = typeof value === 'string' ? value : String(value ?? '');
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(`${field} must be an integer string`);
  return result;
}

/**
 * Server-only ingestion boundary. Caller supplies an already-authenticated principal,
 * never a member ID. All obligation identity and expected chain values are resolved
 * from trusted repository callbacks before evidence verification.
 * This module does not expose HTTP routes and never infers missed/default outcomes.
 */
export function createContributionReputationIngestion({
  reputationStore, evidenceStore, resolveMemberIdentity, resolveTrustedContext,
  verifyEvidence = verifyNearContributionEvidence, verifyRoundBinding,
} = {}) {
  if (!reputationStore || typeof reputationStore.appendVerifiedEvent !== 'function') {
    throw new Error('A trusted reputation store is required');
  }
  if (typeof resolveMemberIdentity !== 'function') throw new Error('A trusted member identity resolver is required');
  if (typeof resolveTrustedContext !== 'function') throw new Error('A trusted contribution context resolver is required');
  if (typeof verifyEvidence !== 'function') throw new Error('A trusted chain evidence verifier is required');
  if (typeof verifyRoundBinding !== 'function') throw new Error('A trusted historical round-binding verifier is required');

  return Object.freeze({
    async ingest({ principal, circleId, round, transactionHash } = {}) {
      const circle = text(circleId, 'circleId');
      const targetRound = validRound(round);
      const txHash = text(transactionHash, 'transactionHash');
      if (!principal || typeof principal !== 'object') throw new Error('An authenticated principal is required');

      const memberId = await resolveMemberIdentity({ principal, circleId: circle });
      if (typeof memberId !== 'string' || !memberId.trim()) throw new Error('Active circle membership could not be established');
      const trusted = await resolveTrustedContext({ circleId: circle, memberId: memberId.trim(), round: targetRound });
      if (!trusted || trusted.circleId !== circle || trusted.memberId !== memberId.trim() || trusted.round !== targetRound) {
        throw new Error('Trusted contribution context is missing or mismatched');
      }
      if (trusted.circleStatus !== 'ACTIVE' || trusted.memberStatus !== 'ACTIVE' || trusted.roundStatus !== 'OPEN') {
        throw new Error('Circle, membership, and round must all be active for contribution evidence ingestion');
      }
      const contractId = text(trusted.contractId, 'trusted contractId');
      const signerId = text(trusted.memberNearAccount, 'trusted memberNearAccount');
      const expectedAmountYocto = decimal(trusted.requiredContributionAmount, 'trusted contribution amount');
      if (expectedAmountYocto === '0') throw new Error('Trusted contribution amount must be positive');
      const expectedDeadlineNs = decimal(trusted.roundDeadlineNs, 'trusted round deadline');
      if (expectedDeadlineNs === '0') throw new Error('Trusted round deadline must be positive');

      const evidence = await verifyEvidence({
        transactionHash: txHash, signerId, contractId, expectedAmountYocto, expectedDeadlineNs,
      });
      if (!evidence || evidence.verified !== true || evidence.outcome !== 'ON_TIME'
          || typeof evidence.digest !== 'string' || !evidence.digest.trim()
          || evidence.evidenceRef !== `near:testnet:tx:${txHash}`
          || evidence.signerId !== signerId || evidence.contractId !== contractId
          || evidence.amountYocto !== expectedAmountYocto || evidence.deadlineNs !== expectedDeadlineNs) {
        throw new Error('Contribution evidence did not match the trusted obligation');
      }

      // A successful contribute() transaction does not encode the circle round in its
      // arguments. Require a trusted historical indexer/state proof to bind this exact
      // finalized transaction to the intended on-chain round; current state alone is
      // insufficient after a cycle advances. No ingestion occurs without this proof.
      const binding = await verifyRoundBinding({
        transactionHash: txHash, contractId, signerId, round: targetRound,
        circleId: circle, evidence,
      });
      if (!binding || binding.verified !== true || binding.transactionHash !== txHash
          || binding.contractId !== contractId || binding.round !== targetRound) {
        throw new Error('Historical transaction-to-round binding could not be verified');
      }

      // Stable obligation ID prevents a second transaction from creating another
      // scoreable event for the same member/circle/round. The store's unique event
      // and evidence constraints additionally block replay of the same transaction.
      if (evidenceStore) {
        if (typeof evidenceStore.recordVerifiedEvidence !== 'function') throw new Error('Durable contribution evidence store is invalid');
        evidenceStore.recordVerifiedEvidence({ evidence, binding, circleId: circle, memberId: memberId.trim(), round: targetRound, expectedAmountYocto, expectedDeadlineNs });
      }
      const obligationId = `${circle}:${targetRound}:${memberId.trim()}`;
      const eventId = `obligation:${obligationId}`;
      const stored = reputationStore.appendVerifiedEvent({
        eventId, memberId: memberId.trim(), circleId: circle, eventKind: 'OBLIGATION',
        payload: { obligationId, outcome: 'ON_TIME' }, evidenceRef: evidence.evidenceRef,
      });
      return Object.freeze({ accepted: true, eventId: stored.eventId, circleId: circle,
        round: targetRound, outcome: 'ON_TIME', evidenceDigest: stored.evidenceDigest });
    },
  });
}

/** Bind ingestion to the authoritative application repository; no HTTP route is added. */
export function createApplicationBackedContributionReputationIngestion({ applicationStore, reputationStore, evidenceStore, getPrincipalId, verifyEvidence, verifyRoundBinding, fetchImpl = globalThis.fetch } = {}) {
  if (!applicationStore || typeof applicationStore.findMembershipForPrincipal !== 'function' || typeof applicationStore.getMemberQuoteContext !== 'function') throw new Error('An authoritative application store is required');
  if (typeof getPrincipalId !== 'function') throw new Error('A trusted principal ID extractor is required');
  const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

  async function resolveMemberIdentity({ principal, circleId } = {}) {
    if (!principal || !nonEmpty(circleId)) return null;
    let principalId;
    try { principalId = await getPrincipalId(principal); } catch { return null; }
    if (!nonEmpty(principalId)) return null;
    let membership;
    try { membership = applicationStore.findMembershipForPrincipal({ principalId: principalId.trim(), circleId: circleId.trim() }); } catch { return null; }
    if (!membership || membership.circleId !== circleId.trim() || membership.status !== 'ACTIVE' || !nonEmpty(membership.memberId)) return null;
    return membership.memberId.trim();
  }

  async function resolveTrustedContext({ circleId, memberId, round } = {}) {
    if (!nonEmpty(circleId) || !nonEmpty(memberId) || !Number.isSafeInteger(round) || round < 0) return null;
    let context;
    try { context = applicationStore.getMemberQuoteContext({ circleId: circleId.trim(), memberId: memberId.trim(), round, allowStaleBindingForEvidence: true }); } catch { return null; }
    if (!context || context.circleId !== circleId.trim() || context.memberId !== memberId.trim() || context.round !== round) return null;
    return Object.freeze({
      circleId: context.circleId, memberId: context.memberId, round: context.round,
      circleStatus: context.circleStatus, memberStatus: context.memberStatus, roundStatus: context.roundStatus,
      contractId: context.contractId, memberNearAccount: context.memberNearAccount,
      requiredContributionAmount: context.requiredContributionAmount, roundDeadlineNs: context.roundDeadlineNs,
    });
  }

  // Production default: use the real finalized transaction's indexed round event.
  // Tests may inject a controlled verifier, but production must never omit this gate.
  const bindRound = verifyRoundBinding ?? (args => verifyIndexedContributionRoundBinding({
    ...args,
    amountYocto: args.evidence?.amountYocto,
    blockHash: args.evidence?.blockHash,
    fetchImpl,
  }));
  return createContributionReputationIngestion({
    reputationStore, evidenceStore, resolveMemberIdentity, resolveTrustedContext, verifyEvidence, verifyRoundBinding: bindRound,
  });
}
