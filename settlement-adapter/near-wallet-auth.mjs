import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const NEP413_PREFIX = 2 ** 31 + 413;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ACCOUNT_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function nowMs(clock) {
  const value = clock();
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('Clock returned an invalid timestamp');
  return ms;
}
function base64url(value) { return Buffer.from(value).toString('base64url'); }
function decodeBase64url(value) {
  if (typeof value !== 'string' || !TOKEN_SEGMENT_RE.test(value)) return null;
  try { return Buffer.from(value, 'base64url'); } catch { return null; }
}
function borshString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function nep413Digest({ message, nonce, recipient, callbackUrl }) {
  if (typeof message !== 'string' || typeof recipient !== 'string' || !Buffer.isBuffer(nonce) || nonce.length !== 32) {
    throw new Error('Invalid NEP-413 payload');
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP413_PREFIX);
  const option = callbackUrl == null
    ? Buffer.from([0])
    : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return createHash('sha256').update(Buffer.concat([prefix, borshString(message), nonce, borshString(recipient), option])).digest();
}
function decodeBase58(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof value !== 'string' || !value.length) return null;
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes++;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}
function equalBuffers(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
}

/** Persistent, single-use NEP-413 challenge store. Use a durable file path outside tests. */
export class NearWalletAuthStore {
  constructor({ path = ':memory:', clock = () => Date.now() } = {}) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
      nonce_hash TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      recipient TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > 0),
      consumed_at_ms INTEGER
    ); CREATE INDEX IF NOT EXISTS wallet_auth_challenge_expiry ON wallet_auth_challenges(expires_at_ms);`);
  }
  createChallenge({ nonce, message, recipient, expiresAtMs }) {
    if (typeof nonce !== 'string' || typeof message !== 'string' || typeof recipient !== 'string' || !Number.isSafeInteger(expiresAtMs)) throw new Error('Invalid challenge');
    const nonceBytes = Buffer.from(nonce, 'base64');
    if (nonceBytes.length !== 32 || nonceBytes.toString('base64') !== nonce) throw new Error('Invalid challenge nonce');
    const nonceHash = createHash('sha256').update(nonceBytes).digest('hex');
    this.db.prepare('INSERT INTO wallet_auth_challenges(nonce_hash,message,recipient,expires_at_ms,consumed_at_ms) VALUES(?,?,?,?,NULL)')
      .run(nonceHash, message, recipient, expiresAtMs);
  }
  getChallenge(nonce) {
    if (typeof nonce !== 'string') return null;
    const nonceBytes = Buffer.from(nonce, 'base64');
    if (nonceBytes.length !== 32 || nonceBytes.toString('base64') !== nonce) return null;
    const nonceHash = createHash('sha256').update(nonceBytes).digest('hex');
    const row = this.db.prepare('SELECT nonce_hash AS nonceHash,message,recipient,expires_at_ms AS expiresAtMs,consumed_at_ms AS consumedAtMs FROM wallet_auth_challenges WHERE nonce_hash = ?').get(nonceHash);
    return row ? { ...row } : null;
  }
  consumeChallenge(nonce, atMs) {
    const challenge = this.getChallenge(nonce);
    if (!challenge || challenge.consumedAtMs !== null || challenge.expiresAtMs <= atMs) return false;
    const result = this.db.prepare('UPDATE wallet_auth_challenges SET consumed_at_ms = ? WHERE nonce_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?')
      .run(atMs, challenge.nonceHash, atMs);
    return Number(result.changes) === 1;
  }
  deleteExpiredChallenges(atMs = nowMs(this.clock)) {
    if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new Error('Cleanup timestamp is invalid');
    const result = this.db.prepare('DELETE FROM wallet_auth_challenges WHERE expires_at_ms <= ?').run(atMs);
    return Number(result.changes);
  }
  close() { this.db.close(); }
}

async function getFullAccessKey({ fetchImpl, rpcUrl, accountId, publicKey }) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ajo-wallet-auth', method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: accountId } }),
  });
  if (!response?.ok) throw new Error('NEAR RPC request failed');
  const data = await response.json();
  if (data?.error || !Array.isArray(data?.result?.keys)) throw new Error('NEAR RPC returned invalid access-key data');
  return data.result.keys.some(item => item?.public_key === publicKey && item?.access_key?.permission === 'FullAccess');
}

/**
 * NEP-413 wallet authentication with injectable RPC and persistent replay protection.
 * Only Ed25519 full-access keys are currently supported; all other key types fail closed.
 */
export function createNearWalletAuthService({
  store, rpcUrl, recipient, issuer = 'ajo-circle', audience = 'ajo-circle-web', sessionSecret,
  clock = () => Date.now(), challengeTtlMs = 5 * 60_000, sessionTtlMs = 15 * 60_000,
  fetchImpl = globalThis.fetch, isAccountSuspended = async () => false,
} = {}) {
  if (!store || typeof store.createChallenge !== 'function' || typeof store.getChallenge !== 'function' || typeof store.consumeChallenge !== 'function') throw new Error('A persistent wallet-auth challenge store is required');
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) throw new Error('A configured NEAR RPC URL is required');
  if (typeof recipient !== 'string' || !recipient.trim() || recipient.length > 255) throw new Error('A fixed application recipient is required');
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32) throw new Error('Session signing secret must be at least 32 bytes');
  if (typeof fetchImpl !== 'function' || typeof isAccountSuspended !== 'function') throw new Error('Trusted RPC and suspension callbacks are required');
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 30_000 || challengeTtlMs > 10 * 60_000) throw new Error('Challenge TTL must be between 30 seconds and 10 minutes');
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 60 * 60_000) throw new Error('Session TTL must be between 1 and 60 minutes');

  function signSession(accountId, issuedAtMs) {
    const issuedAt = Math.floor(issuedAtMs / 1000);
    const expiresAt = Math.floor((issuedAtMs + sessionTtlMs) / 1000);
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iss: issuer, aud: audience, sub: accountId, iat: issuedAt, exp: expiresAt, jti: randomBytes(16).toString('base64url') }));
    const input = `${header}.${payload}`;
    const signature = createHmac('sha256', sessionSecret).update(input).digest('base64url');
    return { token: `${input}.${signature}`, expiresAtMs: expiresAt * 1000 };
  }

  return {
    async issueChallenge() {
      const createdAt = nowMs(clock);
      const expiresAtMs = createdAt + challengeTtlMs;
      const nonce = randomBytes(32).toString('base64');
      const state = randomBytes(16).toString('base64url');
      const message = `Sign in to AjoCircle\nChallenge: ${state}\nIssued: ${new Date(createdAt).toISOString()}\nExpires: ${new Date(expiresAtMs).toISOString()}`;
      store.createChallenge({ nonce, message, recipient: recipient.trim(), expiresAtMs });
      return { nonce, message, recipient: recipient.trim(), expiresAt: new Date(expiresAtMs).toISOString() };
    },
    async verifySignedMessage({ nonce, accountId, publicKey, signature, message, recipient: signedRecipient } = {}) {
      const atMs = nowMs(clock);
      if (typeof accountId !== 'string' || accountId.length < 2 || accountId.length > 64 || !ACCOUNT_ID_RE.test(accountId)) throw new Error('WALLET_AUTH_REJECTED');
      if (typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:') || typeof signature !== 'string') throw new Error('WALLET_AUTH_REJECTED');
      const challenge = store.getChallenge(nonce);
      if (!challenge || challenge.consumedAtMs !== null || challenge.expiresAtMs <= atMs) throw new Error('WALLET_AUTH_REJECTED');
      if (message !== challenge.message || signedRecipient !== challenge.recipient || signedRecipient !== recipient.trim()) throw new Error('WALLET_AUTH_REJECTED');

      const keyBytes = decodeBase58(publicKey.slice('ed25519:'.length));
      let signatureBytes;
      try { signatureBytes = Buffer.from(signature, 'base64'); } catch { throw new Error('WALLET_AUTH_REJECTED'); }
      if (!keyBytes || keyBytes.length !== 32 || signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) throw new Error('WALLET_AUTH_REJECTED');
      let validSignature = false;
      try {
        const keyObject = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), format: 'der', type: 'spki' });
        validSignature = verifySignature(null, nep413Digest({ message, nonce: Buffer.from(nonce, 'base64'), recipient: signedRecipient }), keyObject, signatureBytes);
      } catch { validSignature = false; }
      if (!validSignature) throw new Error('WALLET_AUTH_REJECTED');

      let fullAccess;
      try { fullAccess = await getFullAccessKey({ fetchImpl, rpcUrl, accountId, publicKey }); }
      catch { throw new Error('WALLET_AUTH_REJECTED'); }
      if (!fullAccess) throw new Error('WALLET_AUTH_REJECTED');
      let suspended;
      try { suspended = await isAccountSuspended(accountId); }
      catch { throw new Error('WALLET_AUTH_REJECTED'); }
      if (suspended !== false) throw new Error('WALLET_AUTH_REJECTED');
      if (!store.consumeChallenge(nonce, atMs)) throw new Error('WALLET_AUTH_REJECTED');
      return signSession(accountId, atMs);
    },
  };
}

/** Verifies this app's own HS256 JWT and returns the shape expected by the bearer adapter. */
export function createHmacSessionTokenVerifier({ sessionSecret, issuer = 'ajo-circle', audience = 'ajo-circle-web', clock = () => Date.now(), isAccountSuspended = async () => false } = {}) {
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32) throw new Error('Session signing secret must be at least 32 bytes');
  if (typeof clock !== 'function' || typeof isAccountSuspended !== 'function') throw new Error('Trusted clock and suspension callbacks are required');
  return async function verifyBearerToken(token) {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !TOKEN_SEGMENT_RE.test(part))) return null;
    const headerBytes = decodeBase64url(parts[0]);
    const payloadBytes = decodeBase64url(parts[1]);
    const signature = decodeBase64url(parts[2]);
    if (!headerBytes || !payloadBytes || !signature || signature.length !== 32) return null;
    let header; let payload;
    try { header = JSON.parse(headerBytes.toString('utf8')); payload = JSON.parse(payloadBytes.toString('utf8')); } catch { return null; }
    if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null;
    const expected = createHmac('sha256', sessionSecret).update(`${parts[0]}.${parts[1]}`).digest();
    if (!equalBuffers(signature, expected)) return null;
    const currentMs = nowMs(clock);
    if (payload?.iss !== issuer || payload?.aud !== audience || typeof payload?.sub !== 'string' || !ACCOUNT_ID_RE.test(payload.sub)
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(currentMs / 1000)
        || payload.iat > Math.floor(currentMs / 1000) + 30 || payload.exp <= payload.iat || typeof payload.jti !== 'string') return null;
    let suspended;
    try { suspended = await isAccountSuspended(payload.sub); } catch { return null; }
    if (suspended !== false) return null;
    return { subject: payload.sub, expiresAtMs: payload.exp * 1000 };
  };
}
