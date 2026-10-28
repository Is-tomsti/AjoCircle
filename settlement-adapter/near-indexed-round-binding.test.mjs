import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIndexedContributionRoundBinding } from './near-indexed-round-binding.mjs';

const txHash = '11111111111111111111111111111111';
const blockHash = '22222222222222222222222222222222';
const base = {
  transactionHash: txHash, contractId: 'circle.testnet', signerId: 'member.testnet',
  circleId: 'circle-1', round: 2, amountYocto: '1000000000000000000000000', blockHash,
};
const eventLog = (overrides = {}) => 'EVENT_JSON:' + JSON.stringify({
  standard: 'ajocircle', version: '1.0.0', event: 'contribution_recorded',
  data: [{ member_id: 'member.testnet', round: 2, amount_yocto: base.amountYocto, ...overrides }],
});
function record({ logs = [eventLog()], overrides = {} } = {}) {
  return { transactions: [{
    transaction: { hash: txHash, signer_id: 'member.testnet', receiver_id: 'circle.testnet',
      actions: [{ FunctionCall: { method_name: 'contribute', deposit: base.amountYocto } }] },
    execution_outcome: { block_hash: blockHash },
    receipts: [{ receipt: { receipt_id: '33333333333333333333333333333333', receiver_id: 'circle.testnet' },
      execution_outcome: { outcome: { logs } } }],
    ...overrides,
  }] };
}
function fetchWith(body, { status = 200 } = {}) {
  return async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { tx_hashes: [txHash] });
    return { ok: status === 200, status, json: async () => body };
  };
}

test('accepts a unique indexed round event matching finalized transaction tuple', async () => {
  const result = await verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith(record()) });
  assert.equal(result.verified, true);
  assert.equal(result.round, 2);
  assert.equal(result.blockHash, blockHash);
  assert.match(result.proofRef, /^fastnear:testnet:tx:/);
  assert.match(result.proofDigest, /^sha256:[a-f0-9]{64}$/);
});

test('rejects legacy contract transaction without an explicit round event', async () => {
  await assert.rejects(
    verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith(record({ logs: [] })) }),
    /unique on-chain contribution_recorded round event/,
  );
});

test('rejects a round, signer, or amount mismatch in the indexed event', async () => {
  for (const overrides of [
    { round: 1 },
    { member_id: 'attacker.testnet' },
    { amount_yocto: '7' },
  ]) {
    await assert.rejects(
      verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith(record({ logs: [eventLog(overrides)] })) }),
      /unique on-chain contribution_recorded round event/,
    );
  }
});

test('rejects duplicate matching events rather than selecting one', async () => {
  await assert.rejects(
    verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith(record({ logs: [eventLog(), eventLog()] })) }),
    /unique on-chain contribution_recorded round event/,
  );
});

test('rejects transaction metadata or block mismatch', async () => {
  const wrongTx = record({ overrides: {} });
  wrongTx.transactions[0].transaction.signer_id = 'attacker.testnet';
  await assert.rejects(verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith(wrongTx) }), /trusted hash, signer, and contract/);
  const wrongBlock = record();
  wrongBlock.transactions[0].execution_outcome.block_hash = '44444444444444444444444444444444';
  await assert.rejects(verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith(wrongBlock) }), /block does not match/);
});

test('refuses alternate endpoints and malformed indexer responses', async () => {
  await assert.rejects(verifyIndexedContributionRoundBinding({ ...base, endpoint: 'https://example.com', fetchImpl: fetchWith(record()) }), /Only the configured FastNear testnet/);
  await assert.rejects(verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith({ transactions: [] }) }), /exactly one transaction record/);
});

test('rejects provider HTTP errors', async () => {
  await assert.rejects(verifyIndexedContributionRoundBinding({ ...base, fetchImpl: fetchWith({}, { status: 503 }) }), /HTTP error/);
});

test('accepts the exact verified evidence object shape supplied by reputation ingestion', async () => {
  const evidence = {
    verified: true, transactionHash: txHash, contractId: base.contractId,
    signerId: base.signerId, amountYocto: base.amountYocto, blockHash,
  };
  const result = await verifyIndexedContributionRoundBinding({
    transactionHash: txHash, contractId: base.contractId, signerId: base.signerId,
    circleId: base.circleId, round: base.round, evidence, fetchImpl: fetchWith(record()),
  });
  assert.equal(result.verified, true);
  assert.equal(result.transactionHash, evidence.transactionHash);
  assert.equal(result.blockHash, evidence.blockHash);
  assert.equal(result.round, base.round);
});
