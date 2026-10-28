import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPayoutReadiness, formatYoctoNear } from './payout-agent-readiness.mjs';

const ONE_NEAR = '1000000000000000000000000';
function fakeClient(overrides = {}) {
  const values = {
    get_round: 1,
    get_round_deadline: '2000000000',
    get_round_deadlines: ['1000000000', '2000000000', '3000000000'],
    get_members: ['member1.testnet', 'member2.testnet', 'member3.testnet'],
    get_payout_order: ['member1.testnet', 'member2.testnet', 'member3.testnet'],
    get_current_recipient: 'member2.testnet',
    get_contribution_amount: ONE_NEAR,
    get_contribution_count: 3,
    get_mode: 'ProtectedPublic',
    get_required_protection: '0',
    get_protection_balance: '0',
    get_treasurer_agent: 'circle.testnet',
    is_payout_pending: false,
    is_payout_complete: false,
    is_circle_completed: false,
    ...overrides,
  };
  const calls = [];
  return { calls, view: async (name) => { calls.push(name); if (!Object.hasOwn(values, name)) throw new Error(`Unexpected view ${name}`); return values[name]; } };
}
const options = { contractId: 'circle.testnet', network: 'testnet', bindingVerified: true, nowMs: 1000 };

test('reports ready when all members contributed and payout state is idle', async () => {
  const client = fakeClient();
  const result = await inspectPayoutReadiness(client, options);
  assert.equal(result.status, 'ready');
  assert.equal(result.round, 1);
  assert.equal(result.recipient, 'member2.testnet');
  assert.equal(result.potYocto, (3n * BigInt(ONE_NEAR)).toString());
  assert.equal(result.transactionSubmitted, false);
  assert.ok(client.calls.length > 0);
});

test('waits for the deadline before using protected shortfall', async () => {
  const client = fakeClient({ get_contribution_count: 2, get_required_protection: ONE_NEAR, get_protection_balance: ONE_NEAR });
  const result = await inspectPayoutReadiness(client, options);
  assert.equal(result.status, 'waiting');
  assert.equal(result.missingCount, 1);
});

test('allows protected shortfall only after deadline and with sufficient reserve', async () => {
  const client = fakeClient({ get_contribution_count: 2, get_required_protection: ONE_NEAR, get_protection_balance: ONE_NEAR });
  const result = await inspectPayoutReadiness(client, { ...options, nowMs: 3000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.deadlinePassed, true);
});

test('blocks protected shortfall when reserve is insufficient', async () => {
  const client = fakeClient({ get_contribution_count: 2, get_required_protection: ONE_NEAR, get_protection_balance: '0' });
  const result = await inspectPayoutReadiness(client, { ...options, nowMs: 3000 });
  assert.equal(result.status, 'blocked');
});

test('blocks a private circle with missing contributions', async () => {
  const client = fakeClient({ get_mode: 'Private', get_contribution_count: 2, get_required_protection: '0' });
  const result = await inspectPayoutReadiness(client, { ...options, nowMs: 3000 });
  assert.equal(result.status, 'blocked');
});

test('fails closed without verified contract binding or on wrong network', async () => {
  await assert.rejects(inspectPayoutReadiness(fakeClient(), { ...options, bindingVerified: false }), /binding must be verified/);
  await assert.rejects(inspectPayoutReadiness(fakeClient(), { ...options, network: 'mainnet' }), /restricted to NEAR testnet/);
});

test('fails closed when recipient differs from payout order', async () => {
  await assert.rejects(inspectPayoutReadiness(fakeClient({ get_current_recipient: 'member3.testnet' }), options), /does not match/);
});

test('fails closed when a payout is pending or the circle is completed', async () => {
  await assert.rejects(inspectPayoutReadiness(fakeClient({ is_payout_pending: true }), options), /pending or already complete/);
  await assert.rejects(inspectPayoutReadiness(fakeClient({ is_circle_completed: true }), options), /already completed/);
});

test('formats yoctoNEAR without floating point arithmetic', () => {
  assert.equal(formatYoctoNear(ONE_NEAR), '1 NEAR');
  assert.equal(formatYoctoNear('1250000000000000000000000'), '1.25 NEAR');
});
