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

export function parseOneClickQuote(body, expectedRequest) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('1Click quote response must be a JSON object');
  const quote = body.quote ?? body.quoteResponse?.quote;
  const returnedRequest = body.quoteRequest ?? body.quoteResponse?.quoteRequest ?? body.quoteResponse?.request;
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) throw new Error('1Click quote response is missing quote details');
  if (!returnedRequest || typeof returnedRequest !== 'object' || Array.isArray(returnedRequest)) {
    throw new Error('1Click quote response is missing the echoed quote request');
  }
  {
    for (const field of ['originAsset', 'destinationAsset', 'amount', 'recipient', 'refundTo']) {
      if (returnedRequest[field] !== expectedRequest[field]) throw new Error(`1Click quote request mismatch: ${field}`);
    }
  }
  const depositAddress = requiredText(quote.depositAddress, 'deposit address');
  const minimumAmountOut = baseUnits(quote.minAmountOut, 'minAmountOut');
  const amountOut = baseUnits(quote.amountOut, 'amountOut');
  if (BigInt(amountOut) < BigInt(minimumAmountOut)) throw new Error('1Click quote amountOut is below minAmountOut');
  const depositMemo = quote.depositMemo;
  if (depositMemo !== undefined && (typeof depositMemo !== 'string' || !depositMemo.trim())) throw new Error('1Click quote depositMemo is malformed');
  return Object.freeze({
    depositAddress,
    ...(depositMemo === undefined ? {} : { depositMemo: depositMemo.trim() }),
    originAsset: expectedRequest.originAsset,
    destinationAsset: expectedRequest.destinationAsset,
    recipient: expectedRequest.recipient,
    amountIn: baseUnits(quote.amountIn ?? expectedRequest.amount, 'amountIn'),
    amountOut,
    minimumAmountOut,
    deadline: typeof quote.deadline === 'string' ? quote.deadline : expectedRequest.deadline,
    correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
    signature: typeof body.signature === 'string' ? body.signature : undefined,
  });
}

export class OneClickQuoteClient {
  constructor({ bearerToken, fetchImpl = globalThis.fetch, baseUrl = API_BASE } = {}) {
    if (typeof bearerToken !== 'string' || !bearerToken.trim()) throw new Error('A server-side 1Click API credential is required');
    if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is unavailable');
    this.bearerToken = bearerToken;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getQuote(request) {
    if (!request || typeof request !== 'object' || request.dry !== false) throw new Error('A committed quote request (dry: false) is required');
    const response = await this.fetchImpl(`${this.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.bearerToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`1Click quote endpoint returned HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('1Click returned invalid quote JSON'); }
    return parseOneClickQuote(body, request);
  }
}

export { buildMemberMediatedQuoteRequest };
