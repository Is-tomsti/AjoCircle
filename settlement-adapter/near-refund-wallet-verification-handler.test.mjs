import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNearRefundWalletVerificationHandler,
  NEAR_REFUND_WALLET_VERIFY_PATH
} from './near-refund-wallet-verification-handler.mjs';

function responseStub() {
  return {
    headers: {},
    statusCode: 0,
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ?? ''; }
  };
}

test('requires authentication and derives principal from the authenticated session', async () => {
  let args;
  const handler = createNearRefundWalletVerificationHandler({
    store: {
      verifyNearRefundAddressForPrincipal(value) {
        args = value;
        return { verificationStatus: 'VERIFIED' };
      }
    },
    authenticateRequest: async () => ({ subject: 'alice.near' })
  });
  const response = responseStub();

  await handler({
    method: 'POST',
    url: NEAR_REFUND_WALLET_VERIFY_PATH,
    body: {
      circleId: 'circle-1',
      assetId: 'nep141:token.near',
      address: 'alice.near'
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(args.principalId, 'alice.near');
  assert.equal(args.circleId, 'circle-1');
  assert.equal(args.address, 'alice.near');
});

test('rejects unauthenticated requests without calling the store', async () => {
  let called = false;
  const handler = createNearRefundWalletVerificationHandler({
    store: { verifyNearRefundAddressForPrincipal() { called = true; } },
    authenticateRequest: async () => null
  });
  const response = responseStub();

  await handler({
    method: 'POST',
    url: NEAR_REFUND_WALLET_VERIFY_PATH,
    body: { circleId: 'c', assetId: 'nep141:token.near', address: 'alice.near' }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
});

test('rejects caller-supplied principal IDs and unsupported fields', async () => {
  let called = false;
  const handler = createNearRefundWalletVerificationHandler({
    store: { verifyNearRefundAddressForPrincipal() { called = true; } },
    authenticateRequest: async () => ({ subject: 'alice.near' })
  });
  const response = responseStub();

  await handler({
    method: 'POST',
    url: NEAR_REFUND_WALLET_VERIFY_PATH,
    body: {
      principalId: 'victim',
      circleId: 'c',
      assetId: 'nep141:token.near',
      address: 'alice.near'
    }
  }, response);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'UNSUPPORTED_FIELD' });
  assert.equal(called, false);
});

test('returns a generic rejection when store verification fails', async () => {
  const handler = createNearRefundWalletVerificationHandler({
    store: { verifyNearRefundAddressForPrincipal() { throw new Error('private detail'); } },
    authenticateRequest: async () => ({ subject: 'alice.near' })
  });
  const response = responseStub();

  await handler({
    method: 'POST',
    url: NEAR_REFUND_WALLET_VERIFY_PATH,
    body: { circleId: 'c', assetId: 'nep141:token.near', address: 'mallory.near' }
  }, response);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'REFUND_WALLET_VERIFICATION_REJECTED'
  });
});
