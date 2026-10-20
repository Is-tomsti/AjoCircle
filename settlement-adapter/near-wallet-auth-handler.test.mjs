import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearWalletAuthHandler, NEAR_WALLET_CHALLENGE_PATH, NEAR_WALLET_VERIFY_PATH } from './near-wallet-auth-handler.mjs';
import { startMemberQuoteDevServer } from './member-quote-dev-server.mjs';

async function withServer(service, callback) {
  const handler = createNearWalletAuthHandler({ service });
  const server = await startMemberQuoteDevServer({ handler });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const challenge = { nonce: Buffer.alloc(32, 7).toString('base64'), message: 'Sign in to AjoCircle', recipient: 'ajo-circle.test', expiresAt: '2030-01-01T00:00:00.000Z' };
const signedBody = { nonce: challenge.nonce, accountId: 'alice.near', publicKey: 'ed25519:test', signature: 'signed', message: challenge.message, recipient: challenge.recipient };

test('challenge endpoint returns a no-store challenge and rejects non-POST methods', async () => {
  await withServer({ async issueChallenge() { return challenge; }, async verifySignedMessage() { throw new Error('unused'); } }, async base => {
    const response = await fetch(base + NEAR_WALLET_CHALLENGE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).challenge, challenge);
    const wrongMethod = await fetch(base + NEAR_WALLET_CHALLENGE_PATH);
    assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('allow'), 'POST');
  });
});

test('verify endpoint returns only bearer session metadata on success', async () => {
  await withServer({ async issueChallenge() { return challenge; }, async verifySignedMessage(body) { assert.deepEqual(body, signedBody); return { token: 'app-signed-session', expiresAtMs: 1_900_000_000_000 }; } }, async base => {
    const response = await fetch(base + NEAR_WALLET_VERIFY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedBody) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { token: 'app-signed-session', tokenType: 'Bearer', expiresAt: '2030-03-17T17:46:40.000Z', accountId: 'alice.near' });
  });
});

test('verify endpoint fails closed and does not expose verifier errors', async () => {
  await withServer({ async issueChallenge() { return challenge; }, async verifySignedMessage() { throw new Error('sensitive internal detail'); } }, async base => {
    const response = await fetch(base + NEAR_WALLET_VERIFY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedBody) });
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'WALLET_AUTH_REJECTED' });
  });
});

test('rejects extra fields, malformed JSON, and oversized bodies', async () => {
  await withServer({ async issueChallenge() { return challenge; }, async verifySignedMessage() { throw new Error('must not verify'); } }, async base => {
    let response = await fetch(base + NEAR_WALLET_VERIFY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...signedBody, account: 'attacker' }) });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'INVALID_WALLET_SIGNATURE' });
    response = await fetch(base + NEAR_WALLET_CHALLENGE_PATH, { method: 'POST', body: '{bad' });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'INVALID_JSON' });
    response = await fetch(base + NEAR_WALLET_CHALLENGE_PATH, { method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }) });
    assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'BODY_TOO_LARGE' });
  });
});
