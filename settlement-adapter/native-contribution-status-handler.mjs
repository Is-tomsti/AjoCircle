import { APPROVED_AJOCIRCLE_TESTNET_SHA256S } from './near-contract-verification.mjs';

export const NATIVE_CONTRIBUTION_STATUS_ENDPOINT_PATH =
  '/api/member/native-contribution-status';

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

export function createNativeContributionStatusHandler({
  authenticateRequest, applicationStore, evidenceStore, resolveContractClient
} = {}) {
  if (typeof authenticateRequest !== 'function'
      || typeof applicationStore?.findMembershipForPrincipal !== 'function'
      || typeof applicationStore?.getVerifiedContractBinding !== 'function'
      || typeof evidenceStore?.findVerifiedEvidence !== 'function'
      || typeof resolveContractClient !== 'function') {
    throw new Error('Trusted authentication, stores, and contract resolver are required');
  }

  return async function nativeContributionStatusHandler(request, response) {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return send(response, 400, { error: 'INVALID_REQUEST' });
    }
    if (url.pathname !== NATIVE_CONTRIBUTION_STATUS_ENDPOINT_PATH) {
      return send(response, 404, { error: 'NOT_FOUND' });
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    const circleId = url.searchParams.get('circleId')?.trim();
    const rawRound = url.searchParams.get('round');
    const round = rawRound !== null && /^(0|[1-9]\d*)$/.test(rawRound)
      ? Number(rawRound) : NaN;
    if (!circleId || circleId.length > 200
        || !Number.isSafeInteger(round) || round < 0 || round > 1000) {
      return send(response, 400, { error: 'INVALID_CIRCLE_OR_ROUND' });
    }

    let principal;
    try {
      principal = await authenticateRequest(request);
    } catch {
      principal = null;
    }
    if (!principal || typeof principal.subject !== 'string') {
      return send(response, 401, { error: 'UNAUTHENTICATED' });
    }

    let membership;
    try {
      membership = applicationStore.findMembershipForPrincipal({
        principalId: principal.subject, circleId
      });
    } catch {
      membership = null;
    }
    if (!membership?.memberId) {
      return send(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
    }

    try {
      const binding = applicationStore.getVerifiedContractBinding({ circleId });
      if (!binding || binding.network !== 'testnet'
          || !binding.contractId || !binding.verification?.verified
          || !APPROVED_AJOCIRCLE_TESTNET_SHA256S.includes(
            String(binding.codeSha256).toLowerCase()
          )) {
        return send(response, 409, { error: 'APPROVED_TESTNET_BINDING_REQUIRED' });
      }

      const evidence = evidenceStore.findVerifiedEvidence({
        circleId, memberId: membership.memberId, round
      });

      // Resolver must validate the persisted binding and return a read-only client.
      const client = await resolveContractClient({ circleId, binding });
      const [currentRound, completed, payoutPending, payoutComplete] =
        await Promise.all([
          client.getRound(),
          client.isCircleCompleted(),
          client.isPayoutPending(),
          client.isPayoutComplete()
        ]);

      // Query the member's contribution only when this is the current round.
      const contributionAmountYocto = currentRound === round
        ? await client.getContribution({ member: principal.subject })
        : null;

      return send(response, 200, {
        network: 'testnet',
        circleId,
        contractId: binding.contractId,
        memberNearAccount: principal.subject,
        round,
        storedEvidence: evidence ? {
          verified: true,
          outcome: 'ON_TIME',
          evidenceRef: evidence.evidenceRef,
          transactionHash: evidence.transactionHash,
          amountYocto: evidence.amountYocto,
          deadlineNs: evidence.deadlineNs,
          blockHash: evidence.blockHash,
          recordedAt: evidence.recordedAt
        } : {
          verified: false,
          outcome: 'NO_STORED_VERIFIED_EVIDENCE'
        },
        currentOnChain: {
          queriedAt: new Date().toISOString(),
          currentRound,
          queriedRoundIsCurrent: currentRound === round,
          contributionAmountYocto,
          circleCompleted: completed,
          payoutPending,
          payoutComplete,
          note: currentRound === round
            ? 'Current-round view only. Historical evidence is reported separately.'
            : 'The contract has moved to another round; this current view does not prove historical round status.'
        }
      });
    } catch {
      return send(response, 503, {
        error: 'NATIVE_CONTRIBUTION_STATUS_UNAVAILABLE',
        message: 'Could not safely read verified evidence and testnet contract state. No records were changed.'
      });
    }
  };
}