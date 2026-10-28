import test from 'node:test';
import assert from 'node:assert/strict';
import { MockOneClickQuoteProvider } from './mock-oneclick-quote-provider.mjs';
import { buildMemberMediatedQuoteRequest } from './quote-request.mjs';
import { parseOneClickQuotePreview } from './oneclick-quote.mjs';

const base = {
  originAsset: 'test:synthetic-asset',
  amount: '1000',
  memberNearAccount: 'member.testnet',
  refundTo: 'synthetic-refund-address',
  deadline: '2026-10-25T12:00:00.000Z',
  dry: true,
};

test('offline mock returns explicitly labelled synthetic preview without network access', async () => {
  const provider = new MockOneClickQuoteProvider({ outputAmount: '5000' });
  const request = buildMemberMediatedQuoteRequest(base);
  const body = await provider.getQuotePreview(request);

  assert.equal(body.mockOnly, true);
  assert.equal(body.correlationId, 'mock-preview-no-network');
  assert.deepEqual(body.quoteRequest, request);
  assert.equal(body.quote.amountOut, '5000');
  assert.match(body.quote.amountOutFormatted, /MOCK ONLY/);
  assert.equal('depositAddress' in body.quote, false);
  assert.equal('depositMemo' in body.quote, false);

  const parsed = parseOneClickQuotePreview(body, request);
  assert.equal(parsed.amountOut, '5000');
  assert.equal('depositAddress' in parsed, false);
  assert.equal('depositMemo' in parsed, false);
  assert.equal('signature' in parsed, false);
});

test('offline mock refuses committed quote requests and deposit instructions', async () => {
  const provider = new MockOneClickQuoteProvider();
  await assert.rejects(provider.getQuote({ ...base, dry: false }), /never creates committed quotes/);
  await assert.rejects(provider.getQuotePreview({ ...base, dry: false }), /dry:true/);
});

test('offline mock rejects malformed requests and invalid configured output', async () => {
  assert.throws(() => new MockOneClickQuoteProvider({ outputAmount: '0' }), /positive integer/);
  const provider = new MockOneClickQuoteProvider();
  const request = buildMemberMediatedQuoteRequest(base);
  await assert.rejects(provider.getQuotePreview({ ...request, amount: '0' }), /positive integer/);
  await assert.rejects(provider.getQuotePreview({ ...request, recipient: '' }), /missing recipient/);
});

test('mock response remains bound to the exact requested recipient and amount', async () => {
  const provider = new MockOneClickQuoteProvider({ outputAmount: '2000' });
  const request = buildMemberMediatedQuoteRequest(base);
  const body = await provider.getQuotePreview(request);
  assert.throws(() => parseOneClickQuotePreview(body, { ...request, recipient: 'other.testnet' }), /request mismatch/);
  assert.throws(() => parseOneClickQuotePreview(body, { ...request, amount: '1001' }), /request mismatch|does not match/);
});
