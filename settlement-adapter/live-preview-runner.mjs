import { OneClickQuoteClient } from './oneclick-quote.mjs';
import { buildMemberMediatedQuoteRequest } from './quote-request.mjs';
import { assertLivePreviewRequestAllowed } from './live-preview-safety.mjs';
const text = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' is required.'); return value.trim(); };
/** Live provider preview only. This function never commits a quote or stores an intent. */
export async function requestLiveOneClickPreview({ recipient, refundTo, amount = '1000000', deadline, quoteClient = new OneClickQuoteClient() } = {}) {
  const destination = text(recipient, 'A mainnet NEAR recipient account');
  const refund = text(refundTo, 'A mainnet-compatible NEAR refund account');
  if (typeof quoteClient?.getQuotePreview !== 'function') throw new Error('A preview-only quote client is required.');
  const expires = deadline ?? new Date(Date.now() + 8 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const request = buildMemberMediatedQuoteRequest({ originAsset: 'nep141:usdt.tether-token.near', amount, memberNearAccount: destination, refundTo: refund, slippageTolerance: 100, deadline: expires, depositMode: 'SIMPLE', dry: true });
  assertLivePreviewRequestAllowed(request);
  const quote = await quoteClient.getQuotePreview(request);
  return Object.freeze({ status: 'LIVE_PREVIEW_ONLY', provider: '1Click', dry: true, originAsset: quote.originAsset, destinationAsset: quote.destinationAsset, amountIn: quote.amountIn, estimatedAmountOut: quote.amountOut, amountOutFormatted: quote.amountOutFormatted ?? null, amountOutUsd: quote.amountOutUsd ?? null, minimumAmountOut: quote.minimumAmountOut, timeEstimateSeconds: quote.timeEstimate ?? null, correlationId: quote.correlationId ?? null, note: 'Real market estimate only. No deposit instructions, persisted intent, or transaction was created. Output is wrapped NEAR, not a native-NEAR contribution.' });
}