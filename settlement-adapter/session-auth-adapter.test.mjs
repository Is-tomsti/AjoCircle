import test from 'node:test';
import assert from 'node:assert/strict';
import { createBearerSessionAuthenticator } from './session-auth-adapter.mjs';

const future = 2_000_000_000_000;
const request = authorization => ({ headers: { authorization } });

test('requires an explicit trusted verifier', () => {
  assert.throws(() => createBearerSessionAuthenticator(), /verification callback/);
  assert.throws(() => createBearerSessionAuthenticator({ verifyBearerToken: () => ({}), clock: 1 }), /clock function/);
});

test('passes only a syntactically valid bearer token to verifier and returns minimal principal', async () => {
  const tokens = [];
  const authenticate = createBearerSessionAuthenticator({
    verifyBearerToken: async token => { tokens.push(token); return { subject: ' user-123 ', expiresAtMs: future, email: 'private@example.test' }; },
    clock: () => 1_900_000_000_000,
  });
  const principal = await authenticate(request('Bearer eyJhbGciOi.test-token_123'));
  assert.deepEqual(tokens, ['eyJhbGciOi.test-token_123']);
  assert.deepEqual(principal, { subject: 'user-123' });
  assert.equal(Object.isFrozen(principal), true);
  assert.equal('email' in principal, false);
});

test('rejects absent, malformed, non-bearer, whitespace, and invalid-character headers without verification', async () => {
  let calls = 0;
  const authenticate = createBearerSessionAuthenticator({ verifyBearerToken: async () => { calls++; return { subject: 'u', expiresAtMs: future }; } });
  for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer two tokens', 'Bearer bad!token', ['Bearer abc']]) {
    assert.equal(await authenticate(request(header)), null);
  }
  assert.equal(calls, 0);
});

test('fails closed on rejected verifier, null result, and malformed claims', async () => {
  const results = [null, {}, { subject: '', expiresAtMs: future }, { subject: 'x'.repeat(513), expiresAtMs: future },
    { subject: 'user', expiresAtMs: '2000000000000' }];
  for (const result of results) {
    const authenticate = createBearerSessionAuthenticator({ verifyBearerToken: async () => result, clock: () => 1_900_000_000_000 });
    assert.equal(await authenticate(request('Bearer valid-token')), null);
  }
  const throwing = createBearerSessionAuthenticator({ verifyBearerToken: async () => { throw new Error('secret verifier detail'); } });
  assert.equal(await throwing(request('Bearer valid-token')), null);
});

test('rejects expired and boundary-expired sessions', async () => {
  for (const expiresAtMs of [1_899_999_999_999, 1_900_000_000_000]) {
    const authenticate = createBearerSessionAuthenticator({ verifyBearerToken: async () => ({ subject: 'user', expiresAtMs }), clock: () => 1_900_000_000_000 });
    assert.equal(await authenticate(request('Bearer valid-token')), null);
  }
});

test('accepts case-insensitive header property name but not malformed header value', async () => {
  const authenticate = createBearerSessionAuthenticator({ verifyBearerToken: async () => ({ subject: 'user', expiresAtMs: future }) });
  assert.deepEqual(await authenticate({ headers: { Authorization: 'Bearer valid-token' } }), { subject: 'user' });
});
