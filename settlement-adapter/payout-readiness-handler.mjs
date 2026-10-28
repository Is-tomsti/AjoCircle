import { NearContractReadClient } from './near-contract-read-client.mjs';
import { verifyAjoCircleContract } from './near-contract-verification.mjs';
import { compareCircleSchedule } from './contract-schedule-parity.mjs';
import { inspectPayoutReadiness, formatYoctoNear } from './payout-agent-readiness.mjs';

export const PAYOUT_READINESS_PATH = '/api/agent/payout-readiness';

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body;
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(part, 'utf8');
    if (size > 16 * 1024) throw new Error('BODY_TOO_LARGE');
    raw += part;
  }
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}

/** Authenticated, read-only payout readiness endpoint. It never submits transactions. */
export function createPayoutReadinessHandler({
  store, authenticateRequest, rpcUrl = 'https://rpc.testnet.fastnear.com',
  fetchImpl = globalThis.fetch, verifyContract = verifyAjoCircleContract, clock = () => Date.now(),
} = {}) {
  if (!store || typeof store.findMembershipForPrincipal !== 'function'
      || typeof store.getVerifiedContractBinding !== 'function'
      || typeof store.getCircleScheduleParityContext !== 'function') throw new Error('Trusted application store is required');
  if (typeof authenticateRequest !== 'function') throw new Error('Trusted request authentication is required');
  if (rpcUrl !== 'https://rpc.testnet.fastnear.com') throw new Error('Payout readiness endpoint is testnet-only');
  if (typeof fetchImpl !== 'function' || typeof verifyContract !== 'function' || typeof clock !== 'function') {
    throw new Error('Payout readiness dependencies are invalid');
  }

  return async function payoutReadinessHandler(request, response) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    let principal;
    try { principal = await authenticateRequest(request); } catch { principal = null; }
    if (!principal || typeof principal.subject !== 'string' || !principal.subject.trim()) {
      return sendJson(response, 401, { error: 'UNAUTHENTICATED' });
    }
    let body;
    try { body = await readBody(request); }
    catch (error) {
      return sendJson(response, error?.message === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => key !== 'circleId')
        || typeof body.circleId !== 'string' || !body.circleId.trim() || body.circleId.length > 200) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    const circleId = body.circleId.trim();
    const membership = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
    if (!membership || membership.status !== 'ACTIVE') return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });

    const binding = store.getVerifiedContractBinding({ circleId });
    const parityContext = store.getCircleScheduleParityContext({ circleId });
    if (!binding || binding.network !== 'testnet' || !binding.contractId || !binding.codeSha256
        || !parityContext?.ready || !parityContext.local
        || parityContext.local.contractId !== binding.contractId) {
      return sendJson(response, 409, { error: 'PAYOUT_READINESS_NOT_VERIFIED',
        message: 'A verified testnet contract binding and persisted local schedule are required before payout readiness can be evaluated.' });
    }
    try {
      const live = await verifyContract({
        contractId: binding.contractId,
        expectedMode: parityContext.local.mode,
        rpcUrl, fetchImpl,
      });
      const ageMs = clock() - Date.parse(live.verifiedAt);
      const parity = compareCircleSchedule({ local: parityContext.local, onChain: live });
      if (live.verified !== true || live.network !== 'testnet'
          || live.contractId !== binding.contractId
          || live.codeSha256 !== binding.codeSha256
          || live.mode !== binding.mode
          || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 60_000
          || !parity.matches) {
        return sendJson(response, 409, { error: 'PAYOUT_READINESS_NOT_VERIFIED',
          message: 'Fresh finalized contract evidence no longer matches the approved binding and saved schedule. Reconcile the circle before proceeding.' });
      }
      const client = new NearContractReadClient({ rpcUrl, contractId: binding.contractId, fetchImpl });
      const readiness = await inspectPayoutReadiness(client, {
        contractId: binding.contractId, network: 'testnet', bindingVerified: true, nowMs: clock(),
      });
      return sendJson(response, 200, {
        readiness: {
          ...readiness,
          contribution: formatYoctoNear(readiness.contributionYocto),
          pot: formatYoctoNear(readiness.potYocto),
          protectionBalance: formatYoctoNear(readiness.protectionBalanceYocto),
          requiredProtection: formatYoctoNear(readiness.requiredProtectionYocto),
        },
        liveVerifiedAt: live.verifiedAt,
        codeSha256: live.codeSha256,
        transactionSubmitted: false,
        note: 'Read-only assessment only. This endpoint does not authorize or submit a payout transaction.',
      });
    } catch {
      return sendJson(response, 503, { error: 'PAYOUT_READINESS_UNAVAILABLE',
        message: 'Finalized contract state could not be safely verified. No transaction was submitted.' });
    }
  };
}
