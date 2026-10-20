import test from 'node:test';
import assert from 'node:assert/strict';
import { OneClickQuoteClient, parseOneClickQuote } from './oneclick-quote.mjs';

const request = { dry: false, originAsset: 'asset:source', destinationAsset: 'nep141:wrap.near', amount: '1000', recipient: 'alice.near', refundTo: '0xsource', deadline: '2026-10-21T00:00:00Z' };
const responseBody = { correlationId: 'quote-1', signature: 'sig', quoteRequest: request, quote: { depositAddress: 'deposit-1', depositMemo: 'memo-1', amountIn: '1000', amountOut: '500', minAmountOut: '490', deadline: request.deadline } };

test('parses and validates committed 1Click quote fields', () => {
  const quote = parseOneClickQuote(responseBody, request);
  assert.equal(quote.depositAddress, 'deposit-1');
  assert.equal(quote.depositMemo, 'memo-1');
  assert.equal(quote.minimumAmountOut, '490');
  assert.equal(quote.recipient, 'alice.near');
});

test('rejects a quote for a different recipient or invalid output amounts', () => {
  assert.throws(() => parseOneClickQuote({ ...responseBody, quoteRequest: { ...request, recipient: 'attacker.near' } }, request), /request mismatch/);
  assert.throws(() => parseOneClickQuote({ ...responseBody, quote: { ...responseBody.quote, minAmountOut: '0' } }, request), /positive base-unit/);
  assert.throws(() => parseOneClickQuote({ ...responseBody, quote: { ...responseBody.quote, amountOut: '400' } }, request), /below minAmountOut/);
});

test('posts only to the configured 1Click quote endpoint with server credential', async () => {
  let call;
  const client = new OneClickQuoteClient({ bearerToken: 'server-secret', baseUrl: 'https://example.test/', fetchImpl: async (url, options) => {
    call = { url: String(url), options };
    return { ok: true, async json() { return responseBody; } };
  } });
  const quote = await client.getQuote(request);
  assert.equal(call.url, 'https://example.test/v0/quote');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, 'Bearer server-secret');
  assert.equal(JSON.parse(call.options.body).recipient, 'alice.near');
  assert.equal(quote.depositAddress, 'deposit-1');
});

test('fails closed on HTTP errors and missing credentials', async () => {
  assert.throws(() => new OneClickQuoteClient(), /credential/);
  const client = new OneClickQuoteClient({ bearerToken: 'secret', fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(client.getQuote(request), /HTTP 401/);
});
