import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestnetQuoteClient } from './testnet-quote-client.mjs';

const request = {
  originAsset: 'asset:test-usdc',
  destinationAsset: 'nep141:wrap.near',
  amount: '2000000',
  recipient: 'ajotest1.testnet',
  refundTo: 'testnet-refund-wallet',
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  dry: true,
};

test('offline mock makes no network calls', async () => {
  let calls = 0;
  const { quoteClient } = createTestnetQuoteClient({
    config: { AJO_TESTNET_PREVIEW_PROVIDER: 'offline-mock' },
    fetchImpl: async () => {
      calls++;
      throw new Error('Network call forbidden in offline mock mode');
    },
  });

  const result = await quoteClient.getQuotePreview(request);
  assert.equal(calls, 0);
  assert.match(result.amountOutFormatted, /MOCK ONLY/i);
  assert.equal(result.contributionReady, undefined);
  assert.equal(result.depositAddress, undefined);
});

test('offline mock cannot create committed quotes', async () => {
  let calls = 0;
  const { quoteClient } = createTestnetQuoteClient({
    config: { AJO_TESTNET_PREVIEW_PROVIDER: 'offline-mock' },
    fetchImpl: async () => {
      calls++;
      throw new Error('Unexpected network call');
    },
  });

  await assert.rejects(() => quoteClient.getQuote({ ...request, dry: false }));
  assert.equal(calls, 0);
});

test('preview rejects non-dry requests', async () => {
  const { quoteClient } = createTestnetQuoteClient({
    config: { AJO_TESTNET_PREVIEW_PROVIDER: 'offline-mock' },
  });

  await assert.rejects(
    () => quoteClient.getQuotePreview({ ...request, dry: false }),
    /dry=true/,
  );
});
