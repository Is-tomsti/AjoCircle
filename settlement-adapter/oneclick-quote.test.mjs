import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OneClickQuoteClient,
  parseOneClickQuote,
  parseOneClickQuotePreview,
} from './oneclick-quote.mjs';

const request = { dry: false, originAsset: 'asset:source', destinationAsset: 'nep141:wrap.near', amount: '1000', recipient: 'alice.near', refundTo: '0xsource', deadline: '2026-10-21T00:00:00Z' };
const previewRequest = { ...request, dry: true };
const responseBody = { correlationId: 'quote-1', signature: 'sig', quoteRequest: request, quote: { depositAddress: 'deposit-1', depositMemo: 'memo-1', amountIn: '1000', amountOut: '500', minAmountOut: '490', deadline: request.deadline } };
const previewResponseBody = {
  correlationId: 'preview-1',
  quoteRequest: previewRequest,
  quote: {
    depositAddress: 'MUST_NOT_ESCAPE_PREVIEW',
    depositMemo: 'MUST_NOT_ESCAPE_PREVIEW',
    amountIn: '1000',
    amountOut: '500',
    minAmountOut: '490',
    amountOutFormatted: '0.5 wNEAR',
    amountOutUsd: '2.50',
    timeEstimate: 12,
    deadline: request.deadline,
  },
};

test('parses and validates committed 1Click quote fields', () => {
  const quote = parseOneClickQuote(responseBody, request);
  assert.equal(quote.depositAddress, 'deposit-1');
  assert.equal(quote.depositMemo, 'memo-1');
  assert.equal(quote.minimumAmountOut, '490');
  assert.equal(quote.recipient, 'alice.near');
});

test('rejects a committed quote for a different recipient or invalid output amounts', () => {
  assert.throws(() => parseOneClickQuote({ ...responseBody, quoteRequest: { ...request, recipient: 'attacker.near' } }, request), /request mismatch/);
  assert.throws(() => parseOneClickQuote({ ...responseBody, quote: { ...responseBody.quote, minAmountOut: '0' } }, request), /positive base-unit/);
  assert.throws(() => parseOneClickQuote({ ...responseBody, quote: { ...responseBody.quote, amountOut: '400' } }, request), /below minAmountOut/);
});

test('parses preview estimates but strips all deposit instructions and signature material', () => {
  const quote = parseOneClickQuotePreview(previewResponseBody, previewRequest);
  assert.equal(quote.amountOut, '500');
  assert.equal(quote.minimumAmountOut, '490');
  assert.equal(quote.amountOutFormatted, '0.5 wNEAR');
  assert.equal(quote.amountOutUsd, '2.50');
  assert.equal(quote.timeEstimate, 12);
  assert.equal(quote.recipient, 'alice.near');
  assert.equal('depositAddress' in quote, false);
  assert.equal('depositMemo' in quote, false);
  assert.equal('signature' in quote, false);
});

test('rejects preview requests or responses with wrong mode, recipient, amount, or output bounds', () => {
  assert.throws(() => parseOneClickQuotePreview(previewResponseBody, request), /dry: true/);
  assert.throws(() => parseOneClickQuotePreview({ ...previewResponseBody, quoteRequest: { ...previewRequest, recipient: 'attacker.near' } }, previewRequest), /request mismatch/);
  assert.throws(() => parseOneClickQuotePreview({ ...previewResponseBody, quote: { ...previewResponseBody.quote, amountIn: '999' } }, previewRequest), /does not match/);
  assert.throws(() => parseOneClickQuotePreview({ ...previewResponseBody, quote: { ...previewResponseBody.quote, amountOut: '0' } }, previewRequest), /positive base-unit/);
  assert.throws(() => parseOneClickQuotePreview({ ...previewResponseBody, quote: { ...previewResponseBody.quote, minAmountOut: '600' } }, previewRequest), /below minAmountOut/);
  assert.throws(() => parseOneClickQuotePreview({ quote: previewResponseBody.quote }, previewRequest), /echoed quote request/);
});

test('posts committed quotes only with server credential', async () => {
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

test('allows credential-free dry previews but never credential-free committed quotes', async () => {
  let call;
  const client = new OneClickQuoteClient({ baseUrl: 'https://example.test/', fetchImpl: async (url, options) => {
    call = { url: String(url), options };
    return { ok: true, async json() { return previewResponseBody; } };
  } });
  const quote = await client.getQuotePreview(previewRequest);
  assert.equal(call.url, 'https://example.test/v0/quote');
  assert.equal(JSON.parse(call.options.body).dry, true);
  assert.equal('Authorization' in call.options.headers, false);
  assert.equal('depositAddress' in quote, false);
  await assert.rejects(client.getQuote(request), /credential is required/);
  await assert.rejects(client.getQuotePreview(request), /dry: true/);
});

test('includes bounded provider error details without exposing credentials', async () => {
  const client = new OneClickQuoteClient({ bearerToken: 'top-secret-token', fetchImpl: async () => ({
    ok: false,
    status: 400,
    async json() { return { code: 'INVALID_REQUEST', message: 'unsupported field; token=top-secret-token' }; },
  }) });
  await assert.rejects(client.getQuotePreview(previewRequest), (error) => {
    assert.match(error.message, /HTTP 400: INVALID_REQUEST:/);
    assert.match(error.message, /unsupported field/);
    assert.ok(error.message.includes('[redacted]'));
    assert.doesNotMatch(error.message, /top-secret-token/);
    return true;
  });
});

test('fails closed on HTTP errors and invalid JSON', async () => {
  const client = new OneClickQuoteClient({ bearerToken: 'secret', fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(client.getQuote(request), /HTTP 401/);
  const invalid = new OneClickQuoteClient({ fetchImpl: async () => ({ ok: true, async json() { throw new Error('bad json'); } }) });
  await assert.rejects(invalid.getQuotePreview(previewRequest), /invalid quote JSON/);
});


test('preserves a bounded provider correlation ID for support diagnostics without exposing credentials', async () => {
  const client = new OneClickQuoteClient({ bearerToken: 'top-secret-token', fetchImpl: async () => ({
    ok: false, status: 400,
    async json() { return { message: 'Internal server error', correlationId: 'req-123e4567-echo' }; },
  }) });
  await assert.rejects(client.getQuotePreview(previewRequest), error => {
    assert.match(error.message, /HTTP 400: Internal server error: provider request req-123e4567-echo/);
    assert.doesNotMatch(error.message, /top-secret-token/);
    return true;
  });
});
