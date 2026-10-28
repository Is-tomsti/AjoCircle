import { NearContractReadClient } from './near-contract-read-client.mjs';
import { inspectPublicDistribution } from './public-distribution-assessment.mjs';

export const PUBLIC_DISTRIBUTION_ASSESSMENT_PATH = '/api/agent/public-distribution-assessment';

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

/** Authenticated, read-only public distribution assessment. It never submits transactions. */
export function createPublicDistributionAssessmentHandler({
  store, authenticateRequest, verifyContract, rpcUrl = 'https://rpc.testnet.fastnear.com',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!store || typeof store.findMembershipForPrincipal !== 'function'
      || typeof store.getVerifiedContractBinding !== 'function'
      || typeof store.getCircleScheduleParityContext !== 'function') {
    throw new Error('Trusted application store is required');
  }
  if (typeof authenticateRequest !== 'function' || typeof verifyContract !== 'function'
      || typeof fetchImpl !== 'function') throw new Error('Trusted assessment dependencies are required');
  if (rpcUrl !== 'https://rpc.testnet.fastnear.com') throw new Error('Public distribution assessment is testnet-only');

  return async function publicDistributionAssessmentHandler(request, response) {
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
    try { body = await readBody(request); } catch (error) {
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
    if (!membership || membership.status !== 'ACTIVE') {
      return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
    }

    const binding = store.getVerifiedContractBinding({ circleId });
    const parity = store.getCircleScheduleParityContext({ circleId });
    if (!binding || binding.network !== 'testnet' || !binding.contractId
        || !parity?.ready || !parity.local || parity.local.contractId !== binding.contractId
        || parity.local.mode !== 'PROTECTED_PUBLIC') {
      return sendJson(response, 409, {
        error: 'PUBLIC_DISTRIBUTION_BINDING_NOT_READY',
        message: 'A verified testnet contract binding and matching public-circle schedule are required.',
        transactionSubmitted: false,
      });
    }

    try {
      const live = await verifyContract({
        contractId: binding.contractId,
        expectedMode: parity.local.mode,
        rpcUrl,
        fetchImpl,
      });
      if (live?.verified !== true || live.network !== 'testnet'
          || live.contractId !== binding.contractId || live.codeSha256 !== binding.codeSha256
          || live.mode !== 'ProtectedPublic') {
        return sendJson(response, 409, {
          error: 'PUBLIC_DISTRIBUTION_LIVE_BINDING_MISMATCH',
          message: 'Current finalized contract evidence does not match the stored approved binding.',
          transactionSubmitted: false,
        });
      }
      const client = new NearContractReadClient({ rpcUrl, contractId: binding.contractId, fetchImpl });
      const assessment = await inspectPublicDistribution({
        client, binding, local: parity.local, live,
      });
      return sendJson(response, 200, {
        circleId,
        contractId: binding.contractId,
        assessment,
        transactionSubmitted: false,
        note: 'Read-only on-chain assessment. This endpoint does not authorize, start, continue, or submit distribution transfers.',
      });
    } catch (error) {
      return sendJson(response, 503, {
        error: 'PUBLIC_DISTRIBUTION_ASSESSMENT_UNAVAILABLE',
        message: error?.message || 'Finalized contract state could not be safely assessed.',
        transactionSubmitted: false,
      });
    }
  };
}
