import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationStore } from './application-store.mjs';
import { startAjoTestnetAppServer } from './ajo-testnet-app-server.mjs';

const SECRET = 'integration-test-secret-with-more-than-32-bytes';
const ACCOUNT = 'ajotest1.testnet';
const ORIGIN = 'http://127.0.0.1:5173';
const CIRCLE_ID = 'refund-register-http-circle';
const ASSET_ID = 'nep141:usdt.tether-token.near';

function tokenFor(subject = ACCOUNT) {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({
    iss: 'ajo-circle-testnet-local', aud: 'ajo-circle-testnet-web',
    sub: subject, iat: now, exp: now + 300, jti: 'refund-registration-http-test'
  });
  return input + '.' + createHmac('sha256', SECRET).update(input).digest('base64url');
}

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ajo-refund-register-http-'));
  const paths = {
    auth: join(directory, 'auth.sqlite'),
    application: join(directory, 'application.sqlite'),
    settlement: join(directory, 'settlement.sqlite'),
    reputation: join(directory, 'reputation.sqlite'),
    evidence: join(directory, 'evidence.sqlite'),
    payout: join(directory, 'payout.sqlite'),
    distribution: join(directory, 'distribution.sqlite')
  };
  const store = new ApplicationStore({ path: paths.application });
  try {
    store.upsertCircle({ circleId: CIRCLE_ID, contractId: 'refund-register-http.testnet' });
    store.upsertMember({ memberId: 'refund-register-http-member', principalId: ACCOUNT, nearAccount: ACCOUNT });
    store.createCirclePolicy({ circleId: CIRCLE_ID, mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
    store.setMembership({ circleId: CIRCLE_ID, memberId: 'refund-register-http-member' });
    store.setRound({ circleId: CIRCLE_ID, round: 1, contributionAmount: '1000000000000000000000000', deadlineMs: Date.now() + 60 * 60_000 });
    store.setCircleAsset({ circleId: CIRCLE_ID, assetId: ASSET_ID, maxInputAmount: '5000000' });
  } finally { store.close(); }

  const config = {
    NEAR_RPC_URL: 'https://rpc.testnet.fastnear.com',
    AJO_TESTNET_WEB_ORIGIN: ORIGIN,
    AJO_AUTH_RECIPIENT: ORIGIN,
    AJO_SESSION_SECRET: SECRET,
    AJO_AUTH_DB_PATH: paths.auth,
    AJO_APPLICATION_DB_PATH: paths.application,
    AJO_SETTLEMENT_DB_PATH: paths.settlement,
    AJO_REPUTATION_DB_PATH: paths.reputation,
    AJO_EVIDENCE_DB_PATH: paths.evidence,
    AJO_PAYOUT_EXECUTION_DB_PATH: paths.payout,
    AJO_PUBLIC_DISTRIBUTION_EXECUTION_DB_PATH: paths.distribution
  };
  const server = await startAjoTestnetAppServer({ port: 0, config });
  const address = server.address();
  if (!address || typeof address.port !== 'number') {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw new Error('Test server did not expose an ephemeral port');
  }
  return { directory, paths, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeFixture(fixture) {
  if (!fixture) return;
  await new Promise((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve()));
  await rm(fixture.directory, { recursive: true, force: true });
}

async function post(baseUrl, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json', origin: ORIGIN };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('refund-wallet registration and verification work over real HTTP with authenticated identity and durable storage', async t => {
  const fixture = await makeFixture();
  t.after(async () => closeFixture(fixture));
  const registerPath = '/api/member/refund-wallet/register';
  const verifyPath = '/api/member/refund-wallet/verify';
  const requestBody = { circleId: CIRCLE_ID, assetId: ASSET_ID };

  await t.test('rejects unauthenticated registration', async () => {
    const response = await post(fixture.baseUrl, registerPath, { body: requestBody });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'UNAUTHENTICATED');
  });

  await t.test('registers authenticated account as unverified', async () => {
    const response = await post(fixture.baseUrl, registerPath, { token: tokenFor(), body: requestBody });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.body.registration.address, ACCOUNT);
    assert.equal(response.body.registration.active, true);
    assert.equal(response.body.registration.verificationStatus, 'UNVERIFIED');
    assert.equal(response.body.registration.alreadyRegistered, false);
  });

  await t.test('repeated registration is idempotent', async () => {
    const response = await post(fixture.baseUrl, registerPath, { token: tokenFor(), body: requestBody });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.registration.address, ACCOUNT);
    assert.equal(response.body.registration.alreadyRegistered, true);
    assert.equal(response.body.registration.verificationStatus, 'UNVERIFIED');
  });

  await t.test('rejects caller identity and address overrides', async () => {
    const response = await post(fixture.baseUrl, registerPath, {
      token: tokenFor(), body: { ...requestBody, address: 'attacker.testnet', principalId: 'other.testnet' }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'INVALID_REGISTRATION_REQUEST');
  });

  await t.test('verifies only the matching authenticated NEAR account', async () => {
    const response = await post(fixture.baseUrl, verifyPath, {
      token: tokenFor(), body: { ...requestBody, address: ACCOUNT }
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.verification.address, ACCOUNT);
    assert.equal(response.body.verification.verificationStatus, 'VERIFIED');
    assert.equal(response.body.verification.verificationMethod, 'NEAR_AUTHENTICATED_ACCOUNT_MATCH');
    assert.ok(response.body.verification.verifiedAt);
  });

  await t.test('persists verified registration across database reopen', () => {
    const reopened = new ApplicationStore({ path: fixture.paths.application });
    try {
      const rows = reopened.db.prepare(
        'SELECT r.address, r.active, r.verification_status FROM app_member_refund_addresses r JOIN app_members m ON m.member_id = r.member_id WHERE m.principal_id = ? AND r.asset_id = ?'
      ).all(ACCOUNT, ASSET_ID);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].address, ACCOUNT);
      assert.equal(rows[0].active, 1);
      assert.equal(rows[0].verification_status, 'VERIFIED');
    } finally { reopened.close(); }
  });
});
