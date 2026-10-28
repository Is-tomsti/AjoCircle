import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicDistribution } from './public-distribution-assessment.mjs';

const CONTRACT = 'ajo-demo-fresh.testnet';
const HASH = '39e25e33b245cf6b1db3f4f3fbcec074796308d5741e4c058017123bbbc19674';
const MEMBERS = ['ajotest2.testnet', 'ajotest1.testnet', 'ajotest3.testnet'];
const AMOUNT = '1000000000000000000000000';
const DEADLINES = ['1900000000000000000', '1900000100000000000', '1900000200000000000'];

function fixture(overrides = {}) {
  const local = {
    contractId: CONTRACT,
    mode: 'PROTECTED_PUBLIC',
    members: [...MEMBERS],
    payoutOrder: [...MEMBERS],
    treasurerAgent: CONTRACT,
    currentRound: 2,
    contributionAmount: AMOUNT,
    rounds: DEADLINES.map((deadlineNs, round) => ({ round, deadlineNs, contributionAmount: AMOUNT })),
  };
  const binding = {
    network: 'testnet',
    contractId: CONTRACT,
    codeSha256: HASH,
    mode: 'ProtectedPublic',
  };
  const live = {
    verified: true,
    network: 'testnet',
    contractId: CONTRACT,
    codeSha256: HASH,
    mode: 'ProtectedPublic',
  };
  const values = {
    get_members: [...MEMBERS],
    get_payout_order: [...MEMBERS],
    get_mode: 'ProtectedPublic',
    get_contribution_amount: AMOUNT,
    get_treasurer_agent: CONTRACT,
    get_round: 2,
    get_round_deadlines: [...DEADLINES],
    get_round_deadline: DEADLINES[2],
    is_circle_completed: true,
    is_payout_pending: false,
    is_payout_complete: true,
    are_total_contributions_verified: true,
    get_protection_balance: '0',
    get_public_distribution_plan: [],
    get_public_distribution_index: 0,
    is_public_distribution_pending: false,
    is_public_distribution_complete: false,
  };
  const totals = new Map(MEMBERS.map((member, i) => [member, String(BigInt(i + 1) * BigInt(AMOUNT))]));
  const reserves = new Map(MEMBERS.map(member => [member, '0']));
  const guarantees = new Map(MEMBERS.map(member => [member, null]));
  const client = {
    async view(method, args = {}) {
      if (method === 'get_total_contribution') return totals.get(args.member) ?? null;
      if (method === 'get_reserve_share') return reserves.get(args.funder) ?? '0';
      if (method === 'get_guarantee') return guarantees.get(args.member) ?? null;
      if (!Object.hasOwn(values, method)) throw new Error(`Unexpected view ${method}`);
      return values[method];
    },
  };
  return { client, binding, local, live, values, totals, reserves, guarantees, ...overrides };
}

test('reports READY_TO_START only from verified completed public-circle state', async () => {
  const f = fixture();
  const result = await inspectPublicDistribution(f);
  assert.equal(result.status, 'READY_TO_START');
  assert.equal(result.transactionSubmitted, false);
  assert.deepEqual(result.plan, []);
  assert.equal(Object.keys(result.verifiedTotals).length, MEMBERS.length);
});

test('verifies the on-chain plan against sorted recipients and lifetime totals', async () => {
  const f = fixture();
  const sorted = [...MEMBERS].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  f.values.get_public_distribution_plan = sorted.map(member => [member, f.totals.get(member)]);
  f.values.get_public_distribution_index = 1;
  f.values.is_public_distribution_pending = false;
  const result = await inspectPublicDistribution(f);
  assert.equal(result.status, 'RETRY_AVAILABLE');
  assert.equal(result.index, 1);
  assert.equal(result.plan[0].member, sorted[0]);
});

test('reports pending and completed distribution states without authorizing transactions', async (t) => {
  await t.test('pending', async () => {
    const f = fixture();
    f.values.get_public_distribution_plan = [...MEMBERS].sort().map(member => [member, f.totals.get(member)]);
    f.values.get_public_distribution_index = 1;
    f.values.is_public_distribution_pending = true;
    const result = await inspectPublicDistribution(f);
    assert.equal(result.status, 'TRANSFER_PENDING');
    assert.equal(result.transactionSubmitted, false);
  });

  await t.test('complete', async () => {
    const f = fixture();
    f.values.get_public_distribution_plan = [...MEMBERS].sort().map(member => [member, f.totals.get(member)]);
    f.values.get_public_distribution_index = MEMBERS.length;
    f.values.is_public_distribution_complete = true;
    const result = await inspectPublicDistribution(f);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.complete, true);
  });
});

test('blocks unverified, incomplete, private, or mismatched contract state', async (t) => {
  const cases = [
    ['unverified live contract', f => { f.live.verified = false; }, /not trusted/],
    ['wrong code hash', f => { f.binding.codeSha256 = 'bad'; }, /code hash/],
    ['private local policy', f => { f.local.mode = 'PRIVATE_TRUSTED'; }, /Only verified ProtectedPublic/],
    ['circle not completed', f => { f.values.is_circle_completed = false; }, /Every public round/],
    ['payout still pending', f => { f.values.is_payout_pending = true; }, /legacy payout is still pending/],
    ['final round not complete', f => { f.values.is_payout_complete = false; }, /final public round/],
    ['unverified lifetime totals', f => { f.values.are_total_contributions_verified = false; }, /unverified/],
    ['protection balance remains', f => { f.values.get_protection_balance = '1'; }, /protection obligations/],
    ['schedule mismatch', f => { f.values.get_round_deadlines[1] = '1900000100000000001'; }, /deadlines differ/],
    ['reserve share remains', f => { f.reserves.set(MEMBERS[0], '1'); }, /Reserve-funder obligation/],
    ['guarantee collateral remains', f => { f.guarantees.set(MEMBERS[0], { locked_amount: '1' }); }, /Guarantee collateral/],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, async () => {
      const f = fixture();
      change(f);
      await assert.rejects(inspectPublicDistribution(f), expected);
    });
  }
});

test('blocks a stored plan if any recipient amount differs from verified totals', async () => {
  const f = fixture();
  const sorted = [...MEMBERS].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  f.values.get_public_distribution_plan = sorted.map((member, index) => [
    member,
    index === 0 ? '999' : f.totals.get(member),
  ]);
  await assert.rejects(inspectPublicDistribution(f), /differs from verified lifetime contributions/);
});
