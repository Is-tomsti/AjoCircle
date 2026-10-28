export const NEAR_REFUND_WALLET_VERIFY_PATH = '/api/member/refund-wallet/verify';
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
    const serialized = JSON.stringify(request.body);
    if (Buffer.byteLength(serialized ?? '', 'utf8') > MAX_BODY_BYTES) {
      throw Object.assign(new Error(), { code: 'BODY_TOO_LARGE' });
    }
    return request.body;
  }

  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(part, 'utf8');
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(), { code: 'BODY_TOO_LARGE' });
    raw += part;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(), { code: 'INVALID_JSON' });
  }
}

/** Authenticated verification of an existing NEAR refund-address registration. */
export function createNearRefundWalletVerificationHandler({
  store, authenticateRequest
} = {}) {
  if (!store || typeof store.verifyNearRefundAddressForPrincipal !== 'function') {
    throw new Error('A refund-wallet verification store is required');
  }
  if (typeof authenticateRequest !== 'function') {
    throw new Error('A real request authentication callback is required');
  }

  return async function nearRefundWalletVerificationHandler(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }

    if (pathname !== NEAR_REFUND_WALLET_VERIFY_PATH) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let principal;
    try {
      principal = await authenticateRequest(request);
    } catch {
      principal = null;
    }
    if (!principal || typeof principal.subject !== 'string' || !principal.subject.trim()) {
      return sendJson(response, 401, { error: 'UNAUTHENTICATED' });
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE';
      return sendJson(response, tooLarge ? 413 : 400, {
        error: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON'
      });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(response, 400, { error: 'INVALID_BODY' });
    }

    const allowedKeys = new Set(['circleId', 'assetId', 'address']);
    if (Object.keys(body).some(key => !allowedKeys.has(key))) {
      return sendJson(response, 400, { error: 'UNSUPPORTED_FIELD' });
    }
    if (['circleId', 'assetId', 'address'].some(key =>
      typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 300
    )) {
      return sendJson(response, 400, { error: 'INVALID_VERIFICATION_REQUEST' });
    }

    try {
      const result = store.verifyNearRefundAddressForPrincipal({
        principalId: principal.subject,
        circleId: body.circleId.trim(),
        assetId: body.assetId.trim(),
        address: body.address.trim()
      });
      return sendJson(response, 200, { verification: result });
    } catch {
      return sendJson(response, 403, { error: 'REFUND_WALLET_VERIFICATION_REJECTED' });
    }
  };
}
