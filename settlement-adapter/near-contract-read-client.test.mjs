import test from 'node:test';
import assert from 'node:assert/strict';
import { NearContractReadClient } from './near-contract-read-client.mjs';

function rpcResponse(value) {
  const bytes = [...Buffer.from(JSON.stringify(value), 'utf8')];
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'ajocircle-read', result: { result: bytes } }) };
}

function clientFor(values, captured = []) {
  return new NearContractReadClient({
    rpcUrl: 'https://rpc.example.test',
    contractId: 'circle.testnet',
    fetchImpl: async (url, options) => {
      captured.push({ url, options, request: JSON.parse(options.body) });
      const request = JSON.parse(options.body);
      const method = request.params.method_name;
      if (Object.hasOwn(values, method)) return rpcResponse(values[method]);
      throw new Error(`Unexpected method: ${method}`);
    },
  });
}

test('maps actual AjoCircle view methods and parses NEAR JSON RPC results', async () => {
  const calls = [];
  const client = clientFor({
    get_round: 3,
    get_contribution: '2500000000000000000000000',
    is_circle_completed: false,
    is_payout_pending: true,
    is_payout_complete: false,
  }, calls);
  assert.equal(await client.getRound(), 3);
  assert.equal(await client.getContribution({ member: 'member.testnet' }), '2500000000000000000000000');
  assert.equal(await client.isCircleCompleted(), false);
  assert.equal(await client.isPayoutPending(), true);
  assert.equal(await client.isPayoutComplete(), false);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].request.params.account_id, 'circle.testnet');
  assert.equal(calls[0].request.params.finality, 'final');
  assert.deepEqual(JSON.parse(Buffer.from(calls[1].request.params.args_base64, 'base64').toString('utf8')), { member: 'member.testnet' });
});

test('returns null for a member with no recorded contribution', async () => {
  const client = clientFor({ get_contribution: null });
  assert.equal(await client.getContribution({ member: 'member.testnet' }), null);
});

test('rejects malformed amounts, rounds, and state flags', async () => {
  await assert.rejects(clientFor({ get_contribution: 12 }).getContribution({ member: 'member.testnet' }), /invalid yoctoNEAR amount/);
  await assert.rejects(clientFor({ get_round: -1 }).getRound(), /invalid round/);
  await assert.rejects(clientFor({ is_circle_completed: 'false' }).isCircleCompleted(), /non-boolean/);
});

test('rejects RPC errors and malformed result bytes', async () => {
  const rpcError = new NearContractReadClient({ rpcUrl: 'https://rpc.example.test', contractId: 'circle.testnet', fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'unknown account' } }) }) });
  await assert.rejects(rpcError.getRound(), /NEAR RPC error: unknown account/);
  const badBytes = new NearContractReadClient({ rpcUrl: 'https://rpc.example.test', contractId: 'circle.testnet', fetchImpl: async () => ({ ok: true, json: async () => ({ result: { result: [255] } }) }) });
  await assert.rejects(badBytes.getRound());
});

test('validates required configuration and member identity', async () => {
  assert.throws(() => new NearContractReadClient({ rpcUrl: '', contractId: 'circle.testnet' }), /RPC URL is required/);
  const client = clientFor({});
  await assert.rejects(client.getContribution({ member: ' ' }), /Member NEAR account ID is required/);
});
