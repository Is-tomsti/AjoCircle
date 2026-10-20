import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { NearWalletAuthStore, createNearWalletAuthService, createHmacSessionTokenVerifier } from './near-wallet-auth.mjs';
import { createBearerSessionAuthenticator } from './session-auth-adapter.mjs';

const NOW = 1_900_000_000_000;
const SECRET = 'test-only-session-secret-with-more-than-32-bytes';
const RECIPIENT = 'ajo-circle.test';
function borshString(value) { const bytes = Buffer.from(value); const len = Buffer.alloc(4); len.writeUInt32LE(bytes.length); return Buffer.concat([len, bytes]); }
function digest(message, nonce, recipient) {
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(2 ** 31 + 413);
  return createHash('sha256').update(Buffer.concat([prefix, borshString(message), nonce, borshString(recipient), Buffer.from([0])])).digest();
}
function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + bytes.toString('hex')); let out = '';
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out || '1';
}
function fixture({ suspended = false, fullAccess = true, registeredKeyMatches = true, rpcError = false } = {}) {
  const store = new NearWalletAuthStore({ clock: () => NOW });
  const pair = generateKeyPairSync('ed25519');
  const rawPublic = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKey = 'ed25519:' + base58(rawPublic);
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.params.account_id, 'alice.near');
    if (rpcError) return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { result: { keys: [{ public_key: registeredKeyMatches ? publicKey : 'ed25519:' + base58(Buffer.alloc(32, 3)), access_key: { permission: fullAccess ? 'FullAccess' : { FunctionCall: { receiver_id: 'x.near', method_names: [] } } } }] } }; } };
  };
  const service = createNearWalletAuthService({ store, rpcUrl: 'https://rpc.testnet.near.org', recipient: RECIPIENT,
    sessionSecret: SECRET, clock: () => NOW, fetchImpl, isAccountSuspended: async () => suspended });
  async function signed(challenge, overrides = {}) {
    const nonce = Buffer.from(challenge.nonce, 'base64');
    const signature = sign(null, digest(challenge.message, nonce, challenge.recipient), pair.privateKey).toString('base64');
    return { nonce: challenge.nonce, accountId: 'alice.near', publicKey, signature, message: challenge.message, recipient: challenge.recipient, ...overrides };
  }
  return { store, service, signed, publicKey };
}

test('issues 32-byte unique nonce with fixed recipient and short expiry', async () => {
  const f = fixture();
  try {
    const a = await f.service.issueChallenge(); const b = await f.service.issueChallenge();
    assert.equal(Buffer.from(a.nonce, 'base64').length, 32);
    assert.equal(a.recipient, RECIPIENT);
    assert.ok(Date.parse(a.expiresAt) - NOW <= 5 * 60_000);
    assert.notEqual(a.nonce, b.nonce);
    assert.match(a.message, /Sign in to AjoCircle/);
  } finally { f.store.close(); }
});

test('valid NEP-413 signature for a registered full-access key yields short-lived app JWT', async () => {
  const f = fixture();
  try {
    const challenge = await f.service.issueChallenge();
    const session = await f.service.verifySignedMessage(await f.signed(challenge));
    assert.equal(typeof session.token, 'string');
    assert.ok(session.expiresAtMs > NOW);
    const verifyToken = createHmacSessionTokenVerifier({ sessionSecret: SECRET, clock: () => NOW });
    const authenticate = createBearerSessionAuthenticator({ verifyBearerToken: verifyToken, clock: () => NOW });
    assert.deepEqual(await authenticate({ headers: { authorization: `Bearer ${session.token}` } }), { subject: 'alice.near' });
  } finally { f.store.close(); }
});

test('rejects replayed nonce', async () => {
  const f = fixture();
  try {
    const challenge = await f.service.issueChallenge(); const signed = await f.signed(challenge);
    await f.service.verifySignedMessage(signed);
    await assert.rejects(() => f.service.verifySignedMessage(signed), /WALLET_AUTH_REJECTED/);
  } finally { f.store.close(); }
});

test('concurrent verification attempts can consume one nonce only once', async () => {
  const f = fixture();
  try {
    const challenge = await f.service.issueChallenge(); const signed = await f.signed(challenge);
    const outcomes = await Promise.allSettled([f.service.verifySignedMessage(signed), f.service.verifySignedMessage(signed)]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  } finally { f.store.close(); }
});

test('rejects expired challenge before RPC lookup', async () => {
  const f = fixture();
  try {
    const challenge = await f.service.issueChallenge(); const signed = await f.signed(challenge);
    const late = createNearWalletAuthService({ store: f.store, rpcUrl: 'https://rpc.testnet.near.org', recipient: RECIPIENT,
      sessionSecret: SECRET, clock: () => NOW + 5 * 60_000 + 1, fetchImpl: async () => { throw new Error('RPC must not be called'); } });
    await assert.rejects(() => late.verifySignedMessage(signed), /WALLET_AUTH_REJECTED/);
  } finally { f.store.close(); }
});

test('rejects wrong recipient and altered message', async () => {
  const f = fixture();
  try {
    const challenge = await f.service.issueChallenge();
    const badRecipient = await f.signed(challenge, { recipient: 'attacker.example' });
    const badMessage = await f.signed(challenge, { message: challenge.message + '!' });
    await assert.rejects(() => f.service.verifySignedMessage(badRecipient), /WALLET_AUTH_REJECTED/);
    await assert.rejects(() => f.service.verifySignedMessage(badMessage), /WALLET_AUTH_REJECTED/);
  } finally { f.store.close(); }
});

test('rejects invalid signature and public key not registered for the account', async () => {
  const f = fixture();
  try {
    const challenge = await f.service.issueChallenge(); const signed = await f.signed(challenge);
    await assert.rejects(() => f.service.verifySignedMessage({ ...signed, signature: Buffer.alloc(64).toString('base64') }), /WALLET_AUTH_REJECTED/);
  } finally { f.store.close(); }
  const other = fixture({ registeredKeyMatches: false });
  try {
    const challenge = await other.service.issueChallenge(); const signed = await other.signed(challenge);
    await assert.rejects(() => other.service.verifySignedMessage(signed), /WALLET_AUTH_REJECTED/);
  } finally { other.store.close(); }
  const functionCallKey = fixture({ fullAccess: false });
  try {
    const challenge = await functionCallKey.service.issueChallenge(); const signed = await functionCallKey.signed(challenge);
    await assert.rejects(() => functionCallKey.service.verifySignedMessage(signed), /WALLET_AUTH_REJECTED/);
  } finally { functionCallKey.store.close(); }
});

test('rejects suspended account and RPC failure', async () => {
  const suspended = fixture({ suspended: true });
  try { const c = await suspended.service.issueChallenge(); const signed = await suspended.signed(c); await assert.rejects(() => suspended.service.verifySignedMessage(signed), /WALLET_AUTH_REJECTED/); }
  finally { suspended.store.close(); }
  const failedRpc = fixture({ rpcError: true });
  try { const c = await failedRpc.service.issueChallenge(); const signed = await failedRpc.signed(c); await assert.rejects(() => failedRpc.service.verifySignedMessage(signed), /WALLET_AUTH_REJECTED/); }
  finally { failedRpc.store.close(); }
});

test('session verifier rejects wrong secret, wrong issuer/audience, tampering, expiry, and suspension', async () => {
  const f = fixture();
  try {
    const c = await f.service.issueChallenge(); const signed = await f.signed(c); const session = await f.service.verifySignedMessage(signed);
    const token = session.token;
    assert.equal(await createHmacSessionTokenVerifier({ sessionSecret: 'wrong-secret-that-is-also-over-32-bytes-long', clock: () => NOW })(token), null);
    assert.equal(await createHmacSessionTokenVerifier({ sessionSecret: SECRET, issuer: 'other', clock: () => NOW })(token), null);
    assert.equal(await createHmacSessionTokenVerifier({ sessionSecret: SECRET, audience: 'other', clock: () => NOW })(token), null);
    assert.equal(await createHmacSessionTokenVerifier({ sessionSecret: SECRET, clock: () => session.expiresAtMs })(token), null);
    assert.equal(await createHmacSessionTokenVerifier({ sessionSecret: SECRET, isAccountSuspended: async () => true, clock: () => NOW })(token), null);
    const parts = token.split('.'); parts[1] = parts[1].slice(0, -1) + (parts[1].endsWith('a') ? 'b' : 'a');
    assert.equal(await createHmacSessionTokenVerifier({ sessionSecret: SECRET, clock: () => NOW })(parts.join('.')), null);
  } finally { f.store.close(); }
});
