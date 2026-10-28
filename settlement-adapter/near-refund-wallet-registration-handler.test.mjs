import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNearRefundWalletRegistrationHandler,
  NEAR_REFUND_WALLET_REGISTER_PATH
} from './near-refund-wallet-registration-handler.mjs';

function responseStub() {
  return {
    headers: {},
    statusCode: 0,
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ?? ''; }
  };
}

function request(body, overrides = {}) {
  return {
    method: 'POST',
    url: NEAR_REFUND_WALLET_REGISTER_PATH,
    body,
    ...overrides
  };
}

test('requires authentication and derives principal from authenticated session', async () => {
  let args;
  const handler = createNearRefundWalletRegistrationHandler({
    store: {
      registerNearRefundAddressForPrincipal(value) {
        args = value;
        return { address: 'alice.near', verificationStatus: 'UNVERIFIED', alreadyRegistered: false };
      }
    },
    authenticateRequest: async () => ({ subject: 'alice.near' })
  });
  const response = responseStub();

  await handler(request({ circleId: 'circle-1', assetId: 'nep141:token.near' }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(args, {
    principalId: 'alice.near',
    circleId: 'circle-1',
    assetId: 'nep141:token.near'
  });
  assert.equal(JSON.parse(response.body).registration.verificationStatus, 'UNVERIFIED');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('rejects unauthenticated requests without calling the store', async () => {
  let called = false;
  const handler = createNearRefundWalletRegistrationHandler({
    store: { registerNearRefundAddressForPrincipal() { called = true; } },
    authenticateRequest: async () => null
  });
  const response = responseStub();

  await handler(request({ circleId: 'c', assetId: 'nep141:token.near' }), response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'UNAUTHENTICATED' });
  assert.equal(called, false);
});

test('rejects caller-supplied identity/address and unsupported fields before store access', async (t) => {
  for (const extra of [
    { principalId: 'victim.near' },
    { memberId: 'victim-id' },
    { address: 'victim.near' },
    { walletAddress: 'victim.near' },
    { verified: true }
  ]) {
    await t.test(JSON.stringify(extra), async () => {
      let called = false;
      const handler = createNearRefundWalletRegistrationHandler({
        store: { registerNearRefundAddressForPrincipal() { called = true; } },
        authenticateRequest: async () => ({ subject: 'alice.near' })
      });
      const response = responseStub();

      await handler(request({ circleId: 'c', assetId: 'nep141:token.near', ...extra }), response);

      assert.equal(response.statusCode, 400);
      assert.deepEqual(JSON.parse(response.body), { error: 'INVALID_REGISTRATION_REQUEST' });
      assert.equal(called, false);
    });
  }
});

test('rejects malformed body shapes and missing or invalid required fields', async (t) => {
  const invalidBodies = [
    null,
    [],
    {},
    { circleId: '', assetId: 'nep141:token.near' },
    { circleId: 'c', assetId: '' },
    { circleId: 12, assetId: 'nep141:token.near' },
    { circleId: 'c', assetId: 12 }
  ];

  for (const body of invalidBodies) {
    await t.test(JSON.stringify(body), async () => {
      let called = false;
      const handler = createNearRefundWalletRegistrationHandler({
        store: { registerNearRefundAddressForPrincipal() { called = true; } },
        authenticateRequest: async () => ({ subject: 'alice.near' })
      });
      const response = responseStub();

      await handler(request(body), response);

      assert.equal(response.statusCode, 400);
      assert.equal(called, false);
    });
  }
});

test('rejects wrong methods and paths', async (t) => {
  const handler = createNearRefundWalletRegistrationHandler({
    store: { registerNearRefundAddressForPrincipal() { assert.fail('store must not be called'); } },
    authenticateRequest: async () => ({ subject: 'alice.near' })
  });

  await t.test('wrong method', async () => {
    const response = responseStub();
    await handler(request({}, { method: 'GET' }), response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'POST');
  });

  await t.test('wrong path', async () => {
    const response = responseStub();
    await handler(request({}, { url: '/api/other' }), response);
    assert.equal(response.statusCode, 404);
  });
});

test('returns generic rejection without leaking store errors', async () => {
  const handler = createNearRefundWalletRegistrationHandler({
    store: {
      registerNearRefundAddressForPrincipal() {
        throw new Error('sensitive database detail');
      }
    },
    authenticateRequest: async () => ({ subject: 'alice.near' })
  });
  const response = responseStub();

  await handler(request({ circleId: 'c', assetId: 'nep141:token.near' }), response);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { error: 'REFUND_WALLET_REGISTRATION_REJECTED' });
  assert.equal(response.body.includes('sensitive database detail'), false);
});

test('requires real authentication and registration store dependencies', () => {
  assert.throws(() => createNearRefundWalletRegistrationHandler({}), /registration store is required/);
  assert.throws(() => createNearRefundWalletRegistrationHandler({
    store: { registerNearRefundAddressForPrincipal() {} }
  }), /authentication callback is required/);
});
