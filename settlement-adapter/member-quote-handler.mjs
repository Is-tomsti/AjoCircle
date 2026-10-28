import { createTrustedMemberQuote, createTrustedMemberQuotePreview } from './quote-service.mjs';

export const MEMBER_QUOTE_ENDPOINT_PATH = '/api/member/quote';
export const MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH = '/api/member/quote/preview';
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
    // Framework-parsed bodies no longer expose their original byte stream, so
    // enforce a conservative serialized-size limit at this module boundary too.
    let serialized;
    try { serialized = JSON.stringify(request.body); }
    catch { throw Object.assign(new Error('Invalid parsed body'), { code: 'INVALID_JSON' }); }
    if (Buffer.byteLength(serialized ?? '', 'utf8') > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Body too large'), { code: 'BODY_TOO_LARGE' });
    }
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
  quoteBackendConfigured = true, clock, idFactory, onError = () => {},
} = {}) {
  if (!store || typeof store.createPendingIntent !== 'function') throw new Error('A trusted settlement store is required');
  if (!quoteClient || typeof quoteClient.getQuote !== 'function') throw new Error('A configured 1Click quote client is required');
  if (typeof authenticateRequest !== 'function') throw new Error('A real request authentication callback is required');
  if (typeof resolveMemberIdentity !== 'function') throw new Error('An authoritative member identity resolver is required');
  if (typeof resolveTrustedContext !== 'function') throw new Error('An authoritative circle/member context resolver is required');
  if (typeof quoteBackendConfigured !== 'boolean') throw new Error('quoteBackendConfigured must be a boolean');
  if (typeof onError !== 'function') throw new Error('onError must be a function');

  return async function memberQuoteHandler(request, response) {
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { return sendJson(response, 400, { error: 'INVALID_REQUEST' }); }
    const previewOnly = url.pathname === MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH;
    if (!previewOnly && url.pathname !== MEMBER_QUOTE_ENDPOINT_PATH) return sendJson(response, 404, { error: 'NOT_FOUND' });
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

    let stage = 'member_identity';
    try {
      const circleId = body.circleId.trim();
      const memberIdentity = await resolveMemberIdentity({ principal, circleId });
      const memberId = typeof memberIdentity === 'string' ? memberIdentity : memberIdentity?.memberId;
      if (typeof memberId !== 'string' || !memberId.trim()) return sendJson(response, 403, { error: 'MEMBERSHIP_REQUIRED' });
      stage = 'trusted_context';
      const trusted = await resolveTrustedContext({ circleId, memberId: memberId.trim(), round: body.round });
      if (!trusted) {
        return sendJson(response, 409, {
          error: 'QUOTE_CONTEXT_NOT_READY',
          message: 'Active membership lookup did not produce a quote-ready context. Refresh contract verification and confirm the requested round is current, open, and before its deadline.',
        });
      }
      if (trusted.circleId !== circleId || trusted.memberId !== memberId.trim() || trusted.round !== body.round) {
        return sendJson(response, 403, { error: 'MEMBERSHIP_REQUIRED' });
      }
      const refundTo = trusted.refundAddresses?.[body.originAsset];
      if (typeof refundTo !== 'string' || !refundTo.trim()) return sendJson(response, 400, { error: 'REFUND_WALLET_NOT_REGISTERED' });
      if (!previewOnly && !quoteBackendConfigured) return sendJson(response, 503, { error: 'TESTNET_QUOTE_BACKEND_NOT_CONFIGURED' });
      const quoteOptions = {
        quoteClient, circleId, memberId: memberId.trim(), round: body.round,
        originAsset: body.originAsset, amount: body.amount, refundTo,
        ...(body.slippageTolerance === undefined ? {} : { slippageTolerance: body.slippageTolerance }),
        ...(body.depositMode === undefined ? {} : { depositMode: body.depositMode }),
        // Re-read authoritative membership and lifecycle state inside the quote service.
        // Returning the earlier `trusted` object here would make the service's second
        // validation a no-op and could allow a circle completed between checks to quote.
        resolveTrustedContext: ids => resolveTrustedContext({
          circleId: ids.circleId,
          memberId: ids.memberId,
          round: ids.round,
        }),
        ...(clock ? { clock } : {}),
      };
      if (previewOnly) {
        stage = 'provider_preview';
        const quote = await createTrustedMemberQuotePreview(quoteOptions);
        return sendJson(response, 200, { quote });
      }
      stage = 'provider_committed_quote';
      const quote = await createTrustedMemberQuote({ store, ...quoteOptions, ...(idFactory ? { idFactory } : {}) });
      return sendJson(response, 201, { quote });
    } catch (error) {
      // Keep details in local server logs only; never expose provider errors or trusted context to the browser.
      try {
        onError({
          stage,
          errorName: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error',
          errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined,
          message: typeof error?.message === 'string' ? error.message.slice(0, 240) : 'Unknown quote request failure',
        });
      } catch { /* diagnostics must never change fail-closed request handling */ }
      if (error?.code === 'ROUND_DEADLINE_PASSED') {
        return sendJson(response, 409, {
          error: 'ROUND_DEADLINE_PASSED',
          message: 'This round’s contribution deadline has passed. No quote was created. Do not change the round number manually; verify the current on-chain round and use a valid future round or create a fresh test circle with an approved schedule.',
        });
      }
      return sendJson(response, 422, { error: 'QUOTE_REQUEST_REJECTED' });
    }
  };
}
