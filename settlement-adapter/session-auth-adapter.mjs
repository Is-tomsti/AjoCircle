const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]+=*$/;

/**
 * Create a request authenticator around a real identity-provider verifier.
 *
 * verifyBearerToken MUST verify token authenticity/signature, issuer, audience,
 * expiry, and any provider-specific revocation/session rules. This adapter does
 * not decode or trust client-supplied claims. It only accepts a verified result
 * with a stable subject and a future expiry timestamp, then returns a minimal
 * principal for application-context resolution.
 */
export function createBearerSessionAuthenticator({ verifyBearerToken, clock = () => Date.now() } = {}) {
  if (typeof verifyBearerToken !== 'function') {
    throw new Error('A trusted bearer-token verification callback is required');
  }
  if (typeof clock !== 'function') throw new Error('A clock function is required');

  return async function authenticateRequest(request) {
    const header = request?.headers?.authorization ?? request?.headers?.Authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match || !BEARER_TOKEN_PATTERN.test(match[1])) return null;

    let verified;
    try {
      verified = await verifyBearerToken(match[1]);
    } catch {
      return null;
    }
    if (!verified || typeof verified !== 'object' || Array.isArray(verified)) return null;
    if (typeof verified.subject !== 'string' || !verified.subject.trim() || verified.subject.length > 512) return null;
    if (!Number.isSafeInteger(verified.expiresAtMs) || verified.expiresAtMs <= clock()) return null;

    return Object.freeze({ subject: verified.subject.trim() });
  };
}
