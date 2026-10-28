import test from 'node:test';
import assert from 'node:assert/strict';
import { NearContractReadClient } from './near-contract-read-client.mjs';

function makeClient(views) {
  const calls = [];
  const client = new NearContractReadClient({
    rpcUrl: 'https://rpc.testnet.fastnear.com',
    contractId: 'ajo-demo-fresh.testnet',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const method = request.params.method_name;
      calls.push(method);
      if (!Object.hasOwn(views, method)) {
        throw new Error(`Unexpected view: ${method}`);
      }
      const bytes = Buffer.from(JSON.stringify(views[method]), 'utf8');
      return {
        ok: true,
        async json() {
          return { result: { result: [...bytes] } };
        },
      };
    },
  });
  return { client, calls };
}

test('reads and validates the public distribution plan and lifecycle flags', async () => {
  const { client, calls } = makeClient({
    get_public_distribution_plan: [
      ['ajotest1.testnet', '1000000000000000000000000'],
      ['ajotest2.testnet', '2000000000000000000000000'],
    ],
    get_public_distribution_index: 1,
    is_public_distribution_pending: false,
    is_public_distribution_complete: false,
  });

  assert.deepEqual(await client.getPublicDistributionPlan(), [
    { member: 'ajotest1.testnet', amountYocto: '1000000000000000000000000' },
    { member: 'ajotest2.testnet', amountYocto: '2000000000000000000000000' },
  ]);
  assert.equal(await client.getPublicDistributionIndex(), 1);
  assert.equal(await client.isPublicDistributionPending(), false);
  assert.equal(await client.isPublicDistributionComplete(), false);
  assert.deepEqual(calls, [
    'get_public_distribution_plan',
    'get_public_distribution_index',
    'is_public_distribution_pending',
    'is_public_distribution_complete',
  ]);
});

test('allows an empty plan before distribution starts', async () => {
  const { client } = makeClient({
    get_public_distribution_plan: [],
  });
  assert.deepEqual(await client.getPublicDistributionPlan(), []);
});

test('rejects duplicate recipients and malformed amounts', async (t) => {
  const cases = [
    [
      ['ajotest1.testnet', '10'],
      ['ajotest1.testnet', '20'],
    ],
    [['ajotest1.testnet', '0']],
    [['ajotest1.testnet', 10]],
    [['ajotest1.testnet', '-1']],
    [['ajotest1.testnet', '01']],
    [['bad account', '10']],
    [['ajotest1.testnet']],
  ];

  for (const plan of cases) {
    await t.test(JSON.stringify(plan), async () => {
      const { client } = makeClient({ get_public_distribution_plan: plan });
      await assert.rejects(client.getPublicDistributionPlan());
    });
  }
});

test('rejects invalid distribution indices and non-boolean lifecycle flags', async (t) => {
  for (const index of [-1, 1.5, '1', null]) {
    await t.test(`index ${String(index)}`, async () => {
      const { client } = makeClient({ get_public_distribution_index: index });
      await assert.rejects(client.getPublicDistributionIndex());
    });
  }

  const { client } = makeClient({
    is_public_distribution_pending: 'false',
  });
  await assert.rejects(client.isPublicDistributionPending());
});
