import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicDistributionAssessmentHandler, PUBLIC_DISTRIBUTION_ASSESSMENT_PATH } from './public-distribution-assessment-handler.mjs';

const CONTRACT = 'circle.testnet';
const HASH = 'a'.repeat(64);
const MEMBERS = ['member-b.testnet', 'member-a.testnet'];
const AMOUNT = '1000000000000000000000000';
const DEADLINES = ['1900000000000000000', '1900000100000000000'];

function setup({ principal = { subject: 'member-a.testnet' }, membership = { circleId: 'circle-1', memberId: 'member-a.testnet', status: 'ACTIVE' }, bindingOverrides = {}, localOverrides = {}, liveOverrides = {} } = {}) {
  const local = {
    contractId: CONTRACT, mode: 'PROTECTED_PUBLIC', members: [...MEMBERS],
    payoutOrder: [...MEMBERS], treasurerAgent: CONTRACT, contributionAmount: AMOUNT,
    rounds: DEADLINES.map((deadlineNs, round) => ({ round, deadlineNs, contributionAmount: AMOUNT })),
    ...localOverrides,
  };
  const binding = { network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic', ...bindingOverrides };
  const live = { verified: true, network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic', ...liveOverrides };
  const values = {
    get_members: [...MEMBERS], get_payout_order: [...MEMBERS], get_mode: 'ProtectedPublic',
    get_contribution_amount: AMOUNT, get_treasurer_agent: CONTRACT, get_round: 1,
    get_round_deadlines: [...DEADLINES], get_round_deadline: DEADLINES[1],
    is_circle_completed: true, is_payout_pending: false, is_payout_complete: true,
    are_total_contributions_verified: true, get_protection_balance: '0',
    get_public_distribution_plan: [], get_public_distribution_index: 0,
    is_public_distribution_pending: false, is_public_distribution_complete: false,
  };
  const clientValues = new Map(MEMBERS.map((member, i) => [member, String(BigInt(i + 1) * BigInt(AMOUNT))]));
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    const method = request.params.method_name;
    const args = JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString('utf8'));
    let value;
    if (method === 'get_total_contribution') value = clientValues.get(args.member) ?? null;
    else if (method === 'get_reserve_share') value = '0';
    else if (method === 'get_guarantee') value = null;
    else if (Object.hasOwn(values, method)) value = values[method];
    else throw new Error('Unexpected view method: ' + method);
    return { ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } }) };
  };
  const store = {
    findMembershipForPrincipal: () => membership,
    getVerifiedContractBinding: () => binding,
    getCircleScheduleParityContext: () => ({ ready: true, local }),
  };
  const handler = createPublicDistributionAssessmentHandler({
    store, authenticateRequest: async () => principal, rpcUrl: 'https://rpc.testnet.fastnear.com', fetchImpl,
    verifyContract: async () => live,
  });
  return { handler, values, store, binding, local, live, fetchImpl };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; this.writableEnded = true; },
  };
}

async function call(handler, { method = 'POST', body = { circleId: 'circle-1' }, headers = {} } = {}) {
  const req = { method, url: PUBLIC_DISTRIBUTION_ASSESSMENT_PATH, headers, body };
  const res = response();
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

test('returns read-only assessment for authenticated active member', async () => {
  const { handler } = setup();
  const result = await call(handler);
  assert.equal(result.status, 200);
  assert.equal(result.body.assessment.status, 'READY_TO_START');
  assert.equal(result.body.transactionSubmitted, false);
  assert.match(result.body.note, /does not authorize/);
});

test('rejects unauthenticated or inactive membership', async t => {
  await t.test('unauthenticated', async () => {
    const { handler } = setup({ principal: null });
    assert.equal((await call(handler)).status, 401);
  });
  await t.test('inactive', async () => {
    const { handler } = setup({ membership: { status: 'REMOVED' } });
    const result = await call(handler);
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'ACTIVE_MEMBERSHIP_REQUIRED');
  });
});

test('rejects invalid method and malformed request', async () => {
  const { handler } = setup();
  assert.equal((await call(handler, { method: 'GET' })).status, 405);
  assert.equal((await call(handler, { body: { circleId: 'circle-1', transaction: true } })).status, 400);
});

test('fails closed for non-public or mismatched binding', async t => {
  await t.test('private policy', async () => {
    const { handler } = setup({ localOverrides: { mode: 'PRIVATE_TRUSTED' } });
    assert.equal((await call(handler)).status, 409);
  });
  await t.test('hash mismatch', async () => {
    const { handler } = setup({ liveOverrides: { codeSha256: 'b'.repeat(64) } });
    const result = await call(handler);
    assert.equal(result.status, 409);
    assert.equal(result.body.transactionSubmitted, false);
  });
});
