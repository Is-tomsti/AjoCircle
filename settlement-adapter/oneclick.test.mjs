import test from 'node:test';
import assert from 'node:assert/strict';
import { OneClickStatusClient, parseOneClickStatus, verifyExpectedDelivery } from './oneclick.mjs';

const payload = () => ({
  status: 'SUCCESS',
  quoteResponse: {
    quote: { depositAddress: 'deposit-unique-123' },
    request: { destinationAsset: 'nep141:wrap.near', recipient: 'alice.near' },
  },
  swapDetails: {
    amountOut: '25000000000000000000000000',
    destinationChainTxHashes: [{ hash: 'near-tx-abc', explorerUrl: 'https://example.invalid/tx/near-tx-abc' }],
  },
});
const expected = {
  depositAddress: 'deposit-unique-123',
  destinationAsset: 'nep141:wrap.near',
  recipient: 'alice.near',
  minimumAmountOut: '25000000000000000000000000',
};

test('parses successful 1Click status with destination transaction evidence', () => {
  const status = parseOneClickStatus(payload());
  assert.equal(status.status, 'SUCCESS');
  assert.equal(status.amountOut, 25_000_000_000_000_000_000_000_000n);
  assert.deepEqual(status.destinationTxHashes, ['near-tx-abc']);
});

test('accepts exact expected delivery and returns serializable evidence', () => {
  const verified = verifyExpectedDelivery(parseOneClickStatus(payload()), expected);
  assert.equal(verified.amountOut, expected.minimumAmountOut);
});

test('rejects mismatched deposit address, asset, recipient, and short output', () => {
  const observed = parseOneClickStatus(payload());
  assert.throws(() => verifyExpectedDelivery(observed, { ...expected, depositAddress: 'other' }));
  assert.throws(() => verifyExpectedDelivery(observed, { ...expected, destinationAsset: 'nep141:wrong' }));
  assert.throws(() => verifyExpectedDelivery(observed, { ...expected, recipient: 'mallory.near' }));
  assert.throws(() => verifyExpectedDelivery(observed, { ...expected, minimumAmountOut: '999999999999999999999999999' }));
});

test('rejects pending, processing, failed, refunded, and incomplete states', () => {
  for (const status of ['PENDING_DEPOSIT', 'PROCESSING', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT']) {
    assert.throws(() => verifyExpectedDelivery(parseOneClickStatus({ ...payload(), status }), expected));
  }
});

test('fails closed on missing or malformed response fields', () => {
  assert.throws(() => parseOneClickStatus({ status: 'SUCCESS' }));
  assert.throws(() => parseOneClickStatus({ ...payload(), swapDetails: { ...payload().swapDetails, amountOut: '1.5' } }));
  assert.throws(() => parseOneClickStatus({ ...payload(), swapDetails: { ...payload().swapDetails, destinationChainTxHashes: [] } }) &&
    verifyExpectedDelivery(parseOneClickStatus({ ...payload(), swapDetails: { ...payload().swapDetails, destinationChainTxHashes: [] } }), expected));
});

test('requires a credential and queries status with a trusted address and optional memo', async () => {
  assert.throws(() => new OneClickStatusClient({ bearerToken: '' }));
  let captured;
  const client = new OneClickStatusClient({
    bearerToken: 'test-secret',
    baseUrl: 'https://example.invalid',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return { ok: true, status: 200, json: async () => payload() };
    },
  });
  await client.getStatus({ depositAddress: 'deposit-unique-123', depositMemo: 'memo-7' });
  assert.match(captured.url, /depositAddress=deposit-unique-123/);
  assert.match(captured.url, /depositMemo=memo-7/);
  assert.equal(captured.options.headers.Authorization, 'Bearer test-secret');
  assert.equal(captured.options.method, 'GET');
});

test('rejects HTTP errors and invalid JSON from API', async () => {
  const httpError = new OneClickStatusClient({ bearerToken: 'x', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(httpError.getStatus({ depositAddress: 'deposit-1' }), /HTTP 503/);
  const jsonError = new OneClickStatusClient({ bearerToken: 'x', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) });
  await assert.rejects(jsonError.getStatus({ depositAddress: 'deposit-1' }), /invalid JSON/);
});
