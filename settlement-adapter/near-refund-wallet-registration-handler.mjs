export const NEAR_REFUND_WALLET_REGISTER_PATH = '/api/member/refund-wallet/register';
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    if (Buffer.byteLength(JSON.stringify(request.body) ?? '', 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error(), { code: 'BODY_TOO_LARGE' });
    return request.body;
  }
  let raw = '';
  for await (const chunk of request) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error(), { code: 'BODY_TOO_LARGE' });
  }
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(), { code: 'INVALID_JSON' }); }
}

/** Authenticated, non-destructive registration of the principal's own NEAR account. */
export function createNearRefundWalletRegistrationHandler({ store, authenticateRequest } = {}) {
  if (!store || typeof store.registerNearRefundAddressForPrincipal !== 'function') throw new Error('A refund-wallet registration store is required');
  if (typeof authenticateRequest !== 'function') throw new Error('A real request authentication callback is required');

  return async function nearRefundWalletRegistrationHandler(request, response) {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { return sendJson(response, 400, { error: 'INVALID_REQUEST' }); }
    if (pathname !== NEAR_REFUND_WALLET_REGISTER_PATH) return sendJson(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let principal;
    try { principal = await authenticateRequest(request); } catch { principal = null; }
    if (!principal || typeof principal.subject !== 'string' || !principal.subject.trim()) return sendJson(response, 401, { error: 'UNAUTHENTICATED' });

    let body;
    try { body = await readJsonBody(request); }
    catch (error) {
      const large = error?.code === 'BODY_TOO_LARGE';
      return sendJson(response, large ? 413 : 400, { error: large ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['circleId', 'assetId'].includes(key))
        || ['circleId', 'assetId'].some(key => typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 300)) {
      return sendJson(response, 400, { error: 'INVALID_REGISTRATION_REQUEST' });
    }

    try {
      const result = store.registerNearRefundAddressForPrincipal({
        principalId: principal.subject,
        circleId: body.circleId.trim(),
        assetId: body.assetId.trim()
      });
      return sendJson(response, 200, { registration: result });
    } catch {
      return sendJson(response, 403, { error: 'REFUND_WALLET_REGISTRATION_REJECTED' });
    }
  };
}
