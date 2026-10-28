import test from 'node:test';
import assert from 'node:assert/strict';
import { MockOneClickQuoteProvider } from './mock-oneclick-quote-provider.mjs';
import { parseOneClickQuotePreview } from './oneclick-quote.mjs';
import { createTrustedMemberQuotePreview } from './quote-service.mjs';

const contribution = '1000000000000000000000000';
const trusted = {
  circleId: 'mock-circle',
  memberId: 'mock-member',
  round: 0,
  circleStatus: 'ACTIVE',
  memberStatus: 'ACTIVE',
  roundStatus: 'OPEN',
  memberNearAccount: 'mock-member.testnet',
  requiredContributionAmount: contribution,
  allowedOriginAssets: ['test:synthetic-asset'],
  refundAddresses: { 'test:synthetic-asset': 'synthetic-refund-address' },
  maxInputAmounts: { 'test:synthetic-asset': '1000' },
  roundDeadlineMs: Date.parse('2026-10-26T12:00:00.000Z'),
};

test('trusted preview service integrates the offline mock without persistence or settlement instructions', async () => {
  const provider = new MockOneClickQuoteProvider({ outputAmount: contribution });
  let providerCalls = 0;
  const quoteClient = {
    async getQuotePreview(request) {
      providerCalls += 1;
      const body = await provider.getQuotePreview(request);
      return parseOneClickQuotePreview(body, request);
    },
  };

  const result = await createTrustedMemberQuotePreview({
    quoteClient,
    resolveTrustedContext: async ids => ({ ...trusted, ...ids }),
    circleId: 'mock-circle',
    memberId: 'mock-member',
    round: 0,
    originAsset: 'test:synthetic-asset',
    amount: '1000',
    refundTo: 'synthetic-refund-address',
    clock: () => new Date('2026-10-24T12:00:00.000Z'),
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.status, 'PREVIEW_ONLY');
  assert.equal(result.contributionReady, false);
  assert.equal(result.estimatedAmountOut, contribution);
  assert.equal(result.minimumAmountOut, contribution);
  assert.match(result.amountOutFormatted, /MOCK ONLY/);
  assert.match(result.note, /not a native-NEAR contract contribution/);
  assert.equal('depositAddress' in result, false);
  assert.equal('depositMemo' in result, false);
  assert.equal('signature' in result, false);
});
