export const NEAR_WALLET_CHALLENGE_PATH = '/api/auth/near/challenge';
export const NEAR_WALLET_VERIFY_PATH = '/api/auth/near/verify';
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('pragma', 'no-cache');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}
async function readJson(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    const serialized = JSON.stringify(request.body);
    if (Buffer.byteLength(serialized ?? '', 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error(), { code: 'TOO_LARGE' });
    return request.body;
  }
  let raw = ''; let size = 0;
  for await (const chunk of request) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(text);
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(), { code: 'TOO_LARGE' });
    raw += text;
  }
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(), { code: 'INVALID_JSON' }); }
}

/** HTTP adapter for the NEP-413 challenge and session-exchange endpoints. */
export function createNearWalletAuthHandler({ service } = {}) {
  if (!service || typeof service.issueChallenge !== 'function' || typeof service.verifySignedMessage !== 'function') {
    throw new Error('A configured NEAR wallet authentication service is required');
  }
  return async function nearWalletAuthHandler(request, response) {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { return sendJson(response, 400, { error: 'INVALID_REQUEST' }); }
    if (pathname !== NEAR_WALLET_CHALLENGE_PATH && pathname !== NEAR_WALLET_VERIFY_PATH) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    let body;
    try { body = await readJson(request); }
    catch (error) {
      return sendJson(response, error?.code === 'TOO_LARGE' ? 413 : 400,
        { error: error?.code === 'TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { error: 'INVALID_BODY' });

    if (pathname === NEAR_WALLET_CHALLENGE_PATH) {
      if (Object.keys(body).length !== 0) return sendJson(response, 400, { error: 'UNSUPPORTED_FIELD' });
      try { return sendJson(response, 200, { challenge: await service.issueChallenge() }); }
      catch { return sendJson(response, 503, { error: 'AUTH_TEMPORARILY_UNAVAILABLE' }); }
    }

    const allowed = new Set(['nonce', 'accountId', 'publicKey', 'signature', 'message', 'recipient']);
    if (Object.keys(body).some(key => !allowed.has(key)) || [...allowed].some(key => typeof body[key] !== 'string')) {
      return sendJson(response, 400, { error: 'INVALID_WALLET_SIGNATURE' });
    }
    try {
      const session = await service.verifySignedMessage(body);
      return sendJson(response, 200, { token: session.token, tokenType: 'Bearer', expiresAt: new Date(session.expiresAtMs).toISOString(), accountId: body.accountId });
    } catch {
      return sendJson(response, 401, { error: 'WALLET_AUTH_REJECTED' });
    }
  };
}
