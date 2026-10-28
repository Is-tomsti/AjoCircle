import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationStore } from './application-store.mjs';
import { SettlementStore } from './settlement-store.mjs';
import { startAjoTestnetAppServer } from './ajo-testnet-app-server.mjs';

const SECRET = 'test-only-secret-with-at-least-thirty-two-bytes';
const ACCOUNT = 'ajocircle.testnet';
const ISSUER = 'ajo-circle-testnet-local';
const AUDIENCE = 'ajo-circle-testnet-web';
const ORIGIN = 'http://127.0.0.1:5173';

function tokenFor(subject = ACCOUNT) {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ iss: ISSUER, aud: AUDIENCE, sub: subject, iat: now, exp: now + 300, jti: 'test-jti-1' });
  const input = header + '.' + payload;
  return input + '.' + createHmac('sha256', SECRET).update(input).digest('base64url');
}

async function makeFixture({ withMembership = true, oneClickConfigured = true, suspended = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ajocircle-testnet-app-'));
  const paths = {
    auth: join(directory, 'auth.sqlite'),
    application: join(directory, 'application.sqlite'),
    settlement: join(directory, 'settlement.sqlite'),
    payoutExecution: join(directory, 'payout-execution.sqlite'),
    reputation: join(directory, 'reputation.sqlite'),
    evidence: join(directory, 'evidence.sqlite'),
    publicDistributionExecution: join(directory, 'public-distribution-execution.sqlite'),
  };
  if (withMembership) {
    const app = new ApplicationStore({ path: paths.application });
    try {
      app.upsertCircle({ circleId: 'circle-testnet', contractId: 'circle-testnet.near' });
      app.upsertMember({ memberId: 'member-testnet', principalId: ACCOUNT, nearAccount: ACCOUNT });
      app.createCirclePolicy({ circleId: 'circle-testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
      app.setMembership({ circleId: 'circle-testnet', memberId: 'member-testnet' });
      app.setRound({ circleId: 'circle-testnet', round: 1, contributionAmount: '1000000000000000000000000', deadlineMs: Date.now() + 60 * 60_000 });
      app.setCircleAsset({ circleId: 'circle-testnet', assetId: 'asset:test-usdc', maxInputAmount: '5000000' });
      app.setRefundAddress({ memberId: 'member-testnet', assetId: 'asset:test-usdc', address: 'testnet-refund-wallet' });
    } finally { app.close(); }
  }

  const quoteRequests = [];
  const quoteAuthorization = [];
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), 'https://1click.chaindefuser.com/v0/quote');
    const request = JSON.parse(options.body);
    if (!request.dry) assert.equal(options.headers.Authorization, 'Bearer test-only-1click-token');
    quoteAuthorization.push(options.headers.Authorization);
    quoteRequests.push(request);
    return {
      ok: true,
      async json() {
        return {
          quoteRequest: {
            originAsset: request.originAsset,
            destinationAsset: request.destinationAsset,
            amount: request.amount,
            recipient: request.recipient,
            refundTo: request.refundTo,
          },
          quote: {
            depositAddress: 'testnet-provider-deposit',
            amountIn: request.amount,
            amountOut: '1200000000000000000000000',
            minAmountOut: '1100000000000000000000000',
            deadline: request.deadline,
          },
        };
      },
    };
  };
  const config = {
    NEAR_RPC_URL: 'https://rpc.testnet.fastnear.com',
    AJO_TESTNET_WEB_ORIGIN: ORIGIN,
    AJO_AUTH_RECIPIENT: ORIGIN,
    AJO_SESSION_SECRET: SECRET,
    AJO_AUTH_DB_PATH: paths.auth,
    AJO_APPLICATION_DB_PATH: paths.application,
    AJO_SETTLEMENT_DB_PATH: paths.settlement,
    AJO_PAYOUT_EXECUTION_DB_PATH: paths.payoutExecution,
    AJO_REPUTATION_DB_PATH: paths.reputation,
    AJO_EVIDENCE_DB_PATH: paths.evidence,
    AJO_PUBLIC_DISTRIBUTION_EXECUTION_DB_PATH: paths.publicDistributionExecution,
    AJO_TESTNET_SUSPENDED_ACCOUNTS: suspended,
    ...(oneClickConfigured ? { ONECLICK_API_TOKEN: 'test-only-1click-token' } : {}),
  };
  const server = await startAjoTestnetAppServer({ port: 0, config, fetchImpl });
  return { directory, paths, server, quoteRequests, quoteAuthorization };
}

async function closeFixture(fixture) {
  await new Promise((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve()));
  await rm(fixture.directory, { recursive: true, force: true });
}

const requestBody = {
  circleId: 'circle-testnet',
  round: 1,
  originAsset: 'asset:test-usdc',
  amount: '2000000',
};

test('testnet server rejects quote creation when no verified contract binding exists', async () => {
  const fixture = await makeFixture();
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.server.address().port}/api/member/quote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor()}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'QUOTE_CONTEXT_NOT_READY', message: 'Active membership lookup did not produce a quote-ready context. Refresh contract verification and confirm the requested round is current, open, and before its deadline.' });
    assert.equal(fixture.quoteRequests.length, 0);
    const persisted = new SettlementStore({ path: fixture.paths.settlement });
    try {
      assert.equal(persisted.db.prepare('SELECT COUNT(*) AS count FROM pending_intents').get().count, 0);
    } finally { persisted.close(); }
  } finally { await closeFixture(fixture); }
});

test('testnet server rejects an authenticated wallet without SQLite membership before quote provider call', async () => {
  const fixture = await makeFixture({ withMembership: false });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.server.address().port}/api/member/quote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor()}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'MEMBERSHIP_REQUIRED' });
    assert.equal(fixture.quoteRequests.length, 0);
  } finally { await closeFixture(fixture); }
});

test('testnet server rejects invalid sessions and returns 503 when 1Click credentials are not configured', async () => {
  const fixture = await makeFixture({ oneClickConfigured: false });
  try {
    const base = `http://127.0.0.1:${fixture.server.address().port}`;
    const invalid = await fetch(base + '/api/member/quote', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: 'UNAUTHENTICATED' });

    const unavailable = await fetch(base + '/api/member/quote', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor()}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(unavailable.status, 409);
    assert.deepEqual(await unavailable.json(), { error: 'QUOTE_CONTEXT_NOT_READY', message: 'Active membership lookup did not produce a quote-ready context. Refresh contract verification and confirm the requested round is current, open, and before its deadline.' });
    assert.equal(fixture.quoteRequests.length, 0);
  } finally { await closeFixture(fixture); }
});

test('testnet server blocks a suspended account at session verification', async () => {
  const fixture = await makeFixture({ suspended: ACCOUNT });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.server.address().port}/api/auth/near/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor()}` },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'SESSION_INVALID' });
  } finally { await closeFixture(fixture); }
});

test('testnet server exposes authenticated policy preview and policy-acceptance join routes', async () => {
  const fixture = await makeFixture();
  try {
    const base = `http://127.0.0.1:${fixture.server.address().port}`;
    const headers = { authorization: `Bearer ${tokenFor('new-member.testnet')}`, 'content-type': 'application/json' };
    const preview = await fetch(base + '/api/circle/policy/preview', {
      method: 'POST', headers, body: JSON.stringify({ circleId: 'circle-testnet' }),
    });
    assert.equal(preview.status, 200);
    const policy = (await preview.json()).policy;
    assert.equal(policy.mode, 'PROTECTED_PUBLIC');
    assert.equal(policy.penaltyBps, 500);

    const joined = await fetch(base + '/api/circle/join', {
      method: 'POST', headers,
      body: JSON.stringify({ circleId: 'circle-testnet', policyVersion: policy.policyVersion, accepted: true }),
    });
    assert.equal(joined.status, 201);
    const membership = (await joined.json()).membership;
    assert.equal(membership.status, 'ACTIVE');

    const persisted = new ApplicationStore({ path: fixture.paths.application });
    try {
      assert.equal(persisted.hasAcceptedCirclePolicy({ circleId: 'circle-testnet', policyVersion: 1, memberId: membership.memberId }), true);
      assert.equal(persisted.findMembershipForPrincipal({ principalId: 'new-member.testnet', circleId: 'circle-testnet' }).status, 'ACTIVE');
    } finally { persisted.close(); }
  } finally { await closeFixture(fixture); }
});


test('member journey keeps preview separate from contribution status and fails closed without verified contract binding', async () => {
  const fixture = await makeFixture();
  try {
    const base = `http://127.0.0.1:${fixture.server.address().port}`;
    const headers = { authorization: `Bearer ${tokenFor()}`, 'content-type': 'application/json' };
    const preview = await fetch(base + '/api/member/quote/preview', {
      method: 'POST', headers, body: JSON.stringify(requestBody),
    });
    assert.equal(preview.status, 409);
    assert.deepEqual(await preview.json(), { error: 'QUOTE_CONTEXT_NOT_READY', message: 'Active membership lookup did not produce a quote-ready context. Refresh contract verification and confirm the requested round is current, open, and before its deadline.' });

    const quote = await fetch(base + '/api/member/quote', {
      method: 'POST', headers, body: JSON.stringify(requestBody),
    });
    assert.equal(quote.status, 409);
    assert.deepEqual(await quote.json(), { error: 'QUOTE_CONTEXT_NOT_READY', message: 'Active membership lookup did not produce a quote-ready context. Refresh contract verification and confirm the requested round is current, open, and before its deadline.' });

    const persisted = new SettlementStore({ path: fixture.paths.settlement });
    try {
      assert.equal(persisted.db.prepare('SELECT COUNT(*) AS count FROM pending_intents').get().count, 0);
    } finally { persisted.close(); }
    assert.equal(fixture.quoteRequests.length, 0);
  } finally { await closeFixture(fixture); }
});

test('testnet server blocks even dry previews when no verified contract binding exists', async () => {
  const fixture = await makeFixture({ oneClickConfigured: false });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.server.address().port}/api/member/quote/preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor()}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'QUOTE_CONTEXT_NOT_READY', message: 'Active membership lookup did not produce a quote-ready context. Refresh contract verification and confirm the requested round is current, open, and before its deadline.' });
    assert.equal(fixture.quoteRequests.length, 0);
    const persisted = new SettlementStore({ path: fixture.paths.settlement });
    try {
      assert.equal(persisted.db.prepare('SELECT COUNT(*) AS count FROM pending_intents').get().count, 0);
    } finally { persisted.close(); }
  } finally { await closeFixture(fixture); }
});

test('authenticated provisioning records consent and expected schedule without verifying contract or creating quotes', async () => {
  const fixture = await makeFixture({ withMembership: false });
  const accounts = ['provision-owner.testnet', 'provision-member2.testnet', 'provision-member3.testnet'];
  try {
    const base = `http://127.0.0.1:${fixture.server.address().port}`;
    const post = async (path, account, body) => fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(account)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const created = await post('/api/circle/create', accounts[0], {
      contractId: 'provision-circle.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const circleId = createdBody.circle.circleId;
    assert.equal(createdBody.circle.contractBindingVerified, false);
    assert.equal(createdBody.circle.policyAcceptanceRequired, true);

    for (const account of accounts) {
      const preview = await post('/api/circle/policy/preview', account, { circleId });
      assert.equal(preview.status, 200);
      const policy = (await preview.json()).policy;
      const joined = await post('/api/circle/join', account, {
        circleId, policyVersion: policy.policyVersion, accepted: true,
      });
      assert.equal(joined.status, 201);
      assert.equal((await joined.json()).membership.status, 'ACTIVE');
    }

    const configured = await post('/api/circle/schedule-parity/configure', accounts[0], {
      circleId, members: accounts, payoutOrder: accounts, treasurerAgent: 'provision-circle.testnet',
    });
    assert.equal(configured.status, 200);
    const configuredBody = await configured.json();
    assert.equal(configuredBody.quoteReady, false);
    assert.deepEqual(configuredBody.schedule.members, accounts);
    assert.match(configuredBody.note, /read-only contract verification/i);

    const persisted = new ApplicationStore({ path: fixture.paths.application });
    try {
      for (const account of accounts) {
        const membership = persisted.findMembershipForPrincipal({ principalId: account, circleId });
        assert.equal(membership.status, 'ACTIVE');
        assert.equal(persisted.hasAcceptedCirclePolicy({
          circleId, policyVersion: 1, memberId: membership.memberId,
        }), true);
      }
      assert.equal(persisted.getVerifiedContractBinding({ circleId }), null);
      assert.equal(persisted.getCircleCycleStatus({ circleId }), null);
    } finally { persisted.close(); }
    assert.equal(fixture.quoteRequests.length, 0);
  } finally { await closeFixture(fixture); }
});

test('payout plan endpoint is routed, authenticated, and ledger-only for status requests', async () => {
  const fixture = await makeFixture();
  try {
    const base = 'http://127.0.0.1:' + fixture.server.address().port;
    const unauthenticated = await fetch(base + '/api/agent/payout-plan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', planId: 'missing-plan' }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: 'UNAUTHENTICATED' });

    const missing = await fetch(base + '/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tokenFor(), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', planId: 'missing-plan' }),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'PAYOUT_PLAN_NOT_FOUND' });
  } finally { await closeFixture(fixture); }
});

test('payout readiness endpoint is authenticated and read-only when contract binding is absent', async () => {
  const fixture = await makeFixture();
  try {
    const base = 'http://127.0.0.1:' + fixture.server.address().port;
    const unauthenticated = await fetch(base + '/api/agent/payout-readiness', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ circleId: 'circle-testnet' }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: 'UNAUTHENTICATED' });

    const denied = await fetch(base + '/api/agent/payout-readiness', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tokenFor(), 'content-type': 'application/json' },
      body: JSON.stringify({ circleId: 'circle-testnet' }),
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, 'PAYOUT_READINESS_NOT_VERIFIED');
  } finally { await closeFixture(fixture); }
});
