import { NEAR_WALLET_CHALLENGE_PATH, NEAR_WALLET_VERIFY_PATH } from './near-wallet-auth-handler.mjs';
import { MEMBER_QUOTE_ENDPOINT_PATH } from './member-quote-handler.mjs';

function notFound(response) {
  response.statusCode = 404;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify({ error: 'NOT_FOUND' }));
}

/** Compose auth and member-quote handlers behind one HTTP server without weakening either handler's checks. */
export function createAjoApiHandler({ authHandler, memberQuoteHandler, fallbackHandler } = {}) {
  if (typeof authHandler !== 'function') throw new Error('A NEAR wallet auth handler is required');
  if (typeof memberQuoteHandler !== 'function') throw new Error('A member quote handler is required');
  if (fallbackHandler !== undefined && typeof fallbackHandler !== 'function') throw new Error('Fallback handler must be a function');
  return async function ajoApiHandler(request, response) {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { response.statusCode = 400; response.end(JSON.stringify({ error: 'INVALID_REQUEST' })); return; }
    if (pathname === NEAR_WALLET_CHALLENGE_PATH || pathname === NEAR_WALLET_VERIFY_PATH) return authHandler(request, response);
    if (pathname === MEMBER_QUOTE_ENDPOINT_PATH) return memberQuoteHandler(request, response);
    if (fallbackHandler) return fallbackHandler(request, response);
    return notFound(response);
  };
}
