import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyNearContributionEvidence } from './near-contribution-evidence.mjs';

const wasm = Buffer.from('approved fixture wasm');
const approvedHash = createHash('sha256').update(wasm).digest('hex');
const txHash = '11111111111111111111111111111111';
function mockFetch({ txChanges = {}, blockTimestamp = '1700000000000000000', codeBytes = wasm } = {}) {
  const calls = [];
  const tx = { final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: 'member.testnet', receiver_id: 'circle.testnet', actions: [{ FunctionCall: { method_name: 'contribute', args: 'e30=', deposit: '1000000000000000000000000' } }] }, status: { SuccessValue: '' }, transaction_outcome: { block_hash: 'block-fixture' }, ...txChanges };
  const fetchImpl = async (_url, options) => {
    const req = JSON.parse(options.body); calls.push(req);
    if (req.method === 'query') return { ok: true, json: async () => ({ result: { code_base64: codeBytes.toString('base64') } }) };
    if (req.method === 'tx') return { ok: true, json: async () => ({ result: tx }) };
    if (req.method === 'block') return { ok: true, json: async () => ({ result: { header: { hash: 'block-fixture', timestamp_nanosec: blockTimestamp } } }) };
    throw new Error('unexpected RPC method');
  };
  return { fetchImpl, calls };
}
const args = fetchImpl => ({ transactionHash: txHash, signerId: 'member.testnet', contractId: 'circle.testnet', expectedAmountYocto: '1000000000000000000000000', expectedDeadlineNs: '1800000000000000000', fetchImpl, approvedCodeHashes: [approvedHash] });

test('verifies finalized successful contribution against trusted values and approved code', async () => {
  const { fetchImpl, calls } = mockFetch();
  const result = await verifyNearContributionEvidence(args(fetchImpl));
  assert.equal(result.verified, true);
  assert.equal(result.outcome, 'ON_TIME');
  assert.equal(result.amountYocto, '1000000000000000000000000');
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method !== 'broadcast_tx_commit'));
});

test('rejects unapproved code and unfinalized transaction', async () => {
  const first = mockFetch();
  await assert.rejects(verifyNearContributionEvidence({ ...args(first.fetchImpl), approvedCodeHashes: ['0'.repeat(64)] }), /not on the approved allowlist/);
  const pending = mockFetch({ txChanges: { final_execution_status: 'EXECUTED' } });
  await assert.rejects(verifyNearContributionEvidence(args(pending.fetchImpl)), /not finalized/);
});

test('rejects wrong signer, receiver, method, deposit, and failed execution', async () => {
  const cases = [
    [{ transaction: { hash: txHash, signer_id: 'other.testnet', receiver_id: 'circle.testnet', actions: [{ FunctionCall: { method_name: 'contribute', args: 'e30=', deposit: '1000000000000000000000000' } }] } }, /signer/],
    [{ transaction: { hash: txHash, signer_id: 'member.testnet', receiver_id: 'other.testnet', actions: [{ FunctionCall: { method_name: 'contribute', args: 'e30=', deposit: '1000000000000000000000000' } }] } }, /receiver/],
    [{ transaction: { hash: txHash, signer_id: 'member.testnet', receiver_id: 'circle.testnet', actions: [{ FunctionCall: { method_name: 'fund_protection', args: 'e30=', deposit: '1000000000000000000000000' } }] } }, /not a contribute/],
    [{ transaction: { hash: txHash, signer_id: 'member.testnet', receiver_id: 'circle.testnet', actions: [{ FunctionCall: { method_name: 'contribute', args: 'e30=', deposit: '1' } }] } }, /deposit does not match/],
    [{ transaction: { hash: txHash, signer_id: 'member.testnet', receiver_id: 'circle.testnet', actions: [{ FunctionCall: { method_name: 'contribute', args: 'eyJmb28iOiJiYXIifQ==', deposit: '1000000000000000000000000' } }] } }, /empty JSON object/],
    [{ status: { Failure: { error_message: 'failed' } } }, /did not succeed/],
  ];
  for (const [txChanges, pattern] of cases) {
    const { fetchImpl } = mockFetch({ txChanges });
    await assert.rejects(verifyNearContributionEvidence(args(fetchImpl)), pattern);
  }
});

test('rejects late transaction and non-testnet RPC endpoint', async () => {
  const late = mockFetch({ blockTimestamp: '1800000000000000001' });
  await assert.rejects(verifyNearContributionEvidence(args(late.fetchImpl)), /after the configured deadline/);
  const { fetchImpl } = mockFetch();
  await assert.rejects(verifyNearContributionEvidence({ ...args(fetchImpl), rpcUrl: 'https://rpc.mainnet.near.org' }), /only permits/);
});
