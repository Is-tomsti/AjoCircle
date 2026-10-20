import { createTrustedMemberQuote } from './quote-service.mjs';

export const MEMBER_QUOTE_ENDPOINT_PATH = '/api/member/quote';
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(text);
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { code: 'BODY_TOO_LARGE' });
    raw += text;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' });
  }
}

/**
 * Build the authenticated member quote endpoint. Integration callbacks must use
 * the application's real session/authentication and authoritative membership DB.
 * Client-supplied member IDs and refund addresses are never used as authority.
 */
export function createMemberQuoteHandler({
  store, quoteClient, authenticateRequest, resolveMemberIdentity, resolveTrustedContext,
  clock, idFactory,
} = {}) {
  if (!store || typeof store.createPendingIntent !== 'function') throw new Error('A trusted settlement store is required');
  if (!quoteClient || typeof quoteClient.getQuote !== 'function') throw new Error('A configured 1Click quote client is required');
  if (typeof authenticateRequest !== 'function') throw new Error('A real request authentication callback is required');
  if (typeof resolveMemberIdentity !== 'function') throw new Error('An authoritative member identity resolver is required');
  if (typeof resolveTrustedContext !== 'function') throw new Error('An authoritative circle/member context resolver is required');

  return async function memberQuoteHandler(request, response) {
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { return sendJson(response, 400, { error: 'INVALID_REQUEST' }); }
    if (url.pathname !== MEMBER_QUOTE_ENDPOINT_PATH) return sendJson(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let principal;
    try { principal = await authenticateRequest(request); }
    catch { principal = null; }
    if (!principal) return sendJson(response, 401, { error: 'UNAUTHENTICATED' });

    let body;
    try { body = await readJsonBody(request); }
    catch (error) {
      return sendJson(response, error?.code === 'BODY_TOO_LARGE' ? 413 : 400,
        { error: error?.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { error: 'INVALID_BODY' });
    const allowedKeys = new Set(['circleId', 'round', 'originAsset', 'amount', 'slippageTolerance', 'depositMode']);
    if (Object.keys(body).some(key => !allowedKeys.has(key))) return sendJson(response, 400, { error: 'UNSUPPORTED_FIELD' });
    if (typeof body.circleId !== 'string' || !body.circleId.trim() || body.circleId.length > 200
        || !Number.isSafeInteger(body.round) || body.round < 0
        || typeof body.originAsset !== 'string' || !body.originAsset.trim() || body.originAsset.length > 300
        || typeof body.amount !== 'string' || !/^[1-9][0-9]*$/.test(body.amount)) {
      return sendJson(response, 400, { error: 'INVALID_QUOTE_REQUEST' });
    }

    try {
      const circleId = body.circleId.trim();
      const memberIdentity = await resolveMemberIdentity({ principal, circleId });
      const memberId = typeof memberIdentity === 'string' ? memberIdentity : memberIdentity?.memberId;
      if (typeof memberId !== 'string' || !memberId.trim()) return sendJson(response, 403, { error: 'MEMBERSHIP_REQUIRED' });
      const trusted = await resolveTrustedContext({ circleId, memberId: memberId.trim(), round: body.round });
      if (!trusted || trusted.circleId !== circleId || trusted.memberId !== memberId.trim() || trusted.round !== body.round) {
        return sendJson(response, 403, { error: 'MEMBERSHIP_REQUIRED' });
      }
      const refundTo = trusted.refundAddresses?.[body.originAsset];
      if (typeof refundTo !== 'string' || !refundTo.trim()) return sendJson(response, 400, { error: 'REFUND_WALLET_NOT_REGISTERED' });
      const quote = await createTrustedMemberQuote({
        store, quoteClient, circleId, memberId: memberId.trim(), round: body.round,
        originAsset: body.originAsset, amount: body.amount, refundTo,
        ...(body.slippageTolerance === undefined ? {} : { slippageTolerance: body.slippageTolerance }),
        ...(body.depositMode === undefined ? {} : { depositMode: body.depositMode }),
        resolveTrustedContext: async () => trusted,
        ...(clock ? { clock } : {}), ...(idFactory ? { idFactory } : {}),
      });
      return sendJson(response, 201, { quote });
    } catch {
      return sendJson(response, 422, { error: 'QUOTE_REQUEST_REJECTED' });
    }
  };
}
