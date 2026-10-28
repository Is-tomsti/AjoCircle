import { buildMemberMediatedQuoteRequest } from './quote-request.mjs';

const API_BASE = 'https://1click.chaindefuser.com';
const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`1Click quote is missing ${field}`);
  return value.trim();
};
const baseUnits = (value, field) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(`1Click quote ${field} must be a positive base-unit integer string`);
  return value;
};

function validateEchoedRequest(body, expectedRequest) {
  const returnedRequest = body.quoteRequest ?? body.quoteResponse?.quoteRequest ?? body.quoteResponse?.request;
  if (!returnedRequest || typeof returnedRequest !== 'object' || Array.isArray(returnedRequest)) {
    throw new Error('1Click quote response is missing the echoed quote request');
  }
  for (const field of ['originAsset', 'destinationAsset', 'amount', 'recipient', 'refundTo']) {
    if (returnedRequest[field] !== expectedRequest[field]) throw new Error(`1Click quote request mismatch: ${field}`);
  }
}

function quoteFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('1Click quote response must be a JSON object');
  const quote = body.quote ?? body.quoteResponse?.quote;
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) throw new Error('1Click quote response is missing quote details');
  return quote;
}

async function providerHttpError(response, bearerToken) {
  let detail = '';
  try {
    const body = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const code = typeof body.code === 'string' ? body.code : '';
      const message = typeof body.message === 'string' ? body.message : '';
      const error = typeof body.error === 'string' ? body.error : '';
      const requestIdValue = typeof body.correlationId === 'string' ? body.correlationId
        : typeof body.requestId === 'string' ? body.requestId : '';
      const requestId = requestIdValue.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 80);
      detail = [code, message || error, requestId ? `provider request ${requestId}` : ''].filter(Boolean).join(': ');
    }
  } catch {}
  if (bearerToken) detail = detail.split(bearerToken).join('[redacted]');
  detail = detail.replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 240);
  return new Error(`1Click quote endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

export function parseOneClickQuote(body, expectedRequest) {
  if (!expectedRequest || typeof expectedRequest !== 'object' || expectedRequest.dry !== false) {
    throw new Error('A committed quote request (dry: false) is required');
  }
  const quote = quoteFromBody(body);
  validateEchoedRequest(body, expectedRequest);
  const depositAddress = requiredText(quote.depositAddress, 'deposit address');
  const minimumAmountOut = baseUnits(quote.minAmountOut, 'minAmountOut');
  const amountOut = baseUnits(quote.amountOut, 'amountOut');
  if (BigInt(amountOut) < BigInt(minimumAmountOut)) throw new Error('1Click quote amountOut is below minAmountOut');
  const depositMemo = quote.depositMemo;
  if (depositMemo !== undefined && (typeof depositMemo !== 'string' || !depositMemo.trim())) throw new Error('1Click quote depositMemo is malformed');
  const amountIn = baseUnits(quote.amountIn ?? expectedRequest.amount, 'amountIn');
  if (amountIn !== expectedRequest.amount) throw new Error('1Click quote amountIn does not match the requested amount');
  return Object.freeze({
    depositAddress,
    ...(depositMemo === undefined ? {} : { depositMemo: depositMemo.trim() }),
    originAsset: expectedRequest.originAsset,
    destinationAsset: expectedRequest.destinationAsset,
    recipient: expectedRequest.recipient,
    amountIn,
    amountOut,
    minimumAmountOut,
    deadline: typeof quote.deadline === 'string' ? quote.deadline : expectedRequest.deadline,
    correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
    signature: typeof body.signature === 'string' ? body.signature : undefined,
  });
}

/**
 * Parse an estimate-only 1Click response. This deliberately strips any deposit
 * address, memo, signature, or other settlement instruction even if a provider
 * response unexpectedly includes those fields for a dry request.
 */
export function parseOneClickQuotePreview(body, expectedRequest) {
  if (!expectedRequest || typeof expectedRequest !== 'object' || expectedRequest.dry !== true) {
    throw new Error('A preview quote request (dry: true) is required');
  }
  const quote = quoteFromBody(body);
  validateEchoedRequest(body, expectedRequest);
  const amountIn = baseUnits(quote.amountIn ?? expectedRequest.amount, 'amountIn');
  if (amountIn !== expectedRequest.amount) throw new Error('1Click preview amountIn does not match the requested amount');
  const amountOut = baseUnits(quote.amountOut, 'amountOut');
  const minimumAmountOut = baseUnits(quote.minAmountOut ?? quote.amountOut, 'minAmountOut');
  if (BigInt(amountOut) < BigInt(minimumAmountOut)) throw new Error('1Click preview amountOut is below minAmountOut');
  const amountOutUsd = quote.amountOutUsd;
  const timeEstimate = quote.timeEstimate;
  return Object.freeze({
    originAsset: expectedRequest.originAsset,
    destinationAsset: expectedRequest.destinationAsset,
    recipient: expectedRequest.recipient,
    amountIn,
    amountOut,
    minimumAmountOut,
    deadline: typeof quote.deadline === 'string' ? quote.deadline : expectedRequest.deadline,
    ...(typeof quote.amountOutFormatted === 'string' ? { amountOutFormatted: quote.amountOutFormatted } : {}),
    ...(typeof amountOutUsd === 'string' || (typeof amountOutUsd === 'number' && Number.isFinite(amountOutUsd))
      ? { amountOutUsd } : {}),
    ...(typeof timeEstimate === 'number' && Number.isFinite(timeEstimate) && timeEstimate >= 0
      ? { timeEstimate } : {}),
    ...(typeof body.correlationId === 'string' ? { correlationId: body.correlationId } : {}),
  });
}

export class OneClickQuoteClient {
  constructor({ bearerToken, fetchImpl = globalThis.fetch, baseUrl = API_BASE } = {}) {
    if (bearerToken !== undefined && (typeof bearerToken !== 'string' || !bearerToken.trim())) {
      throw new Error('1Click API credential must be a non-empty string when supplied');
    }
    if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is unavailable');
    this.bearerToken = typeof bearerToken === 'string' ? bearerToken.trim() : undefined;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async #fetchQuote(request) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    const response = await this.fetchImpl(`${this.baseUrl}/v0/quote`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await providerHttpError(response, this.bearerToken);
    let body;
    try { body = await response.json(); } catch { throw new Error('1Click returned invalid quote JSON'); }
    return body;
  }

  async getQuote(request) {
    if (!request || typeof request !== 'object' || request.dry !== false) throw new Error('A committed quote request (dry: false) is required');
    if (!this.bearerToken) throw new Error('A server-side 1Click API credential is required for committed quotes');
    return parseOneClickQuote(await this.#fetchQuote(request), request);
  }

  async getQuotePreview(request) {
    if (!request || typeof request !== 'object' || request.dry !== true) throw new Error('A preview quote request (dry: true) is required');
    return parseOneClickQuotePreview(await this.#fetchQuote(request), request);
  }
}

export { buildMemberMediatedQuoteRequest };
