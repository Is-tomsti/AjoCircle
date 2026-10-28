import { randomUUID } from 'node:crypto';
import { buildMemberMediatedQuoteRequest } from './quote-request.mjs';

const positiveUnits = (value, field) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${field} must be a positive base-unit integer string`);
  return value;
};
const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
};

export async function createTrustedMemberQuote({
  store, quoteClient, resolveTrustedContext, circleId, memberId, round,
  originAsset, amount, refundTo, slippageTolerance = 100, depositMode = 'SIMPLE',
  clock = () => new Date(), idFactory = randomUUID,
} = {}) {
  if (!store || typeof store.createPendingIntent !== 'function') throw new Error('A trusted settlement store is required');
  if (!quoteClient || typeof quoteClient.getQuote !== 'function') throw new Error('A configured 1Click quote client is required');
  if (typeof resolveTrustedContext !== 'function') throw new Error('A trusted circle/member context resolver is required');
  const requestedCircleId = requiredText(circleId, 'circleId');
  const requestedMemberId = requiredText(memberId, 'memberId');
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
  const trusted = await resolveTrustedContext({ circleId: requestedCircleId, memberId: requestedMemberId, round });
  if (!trusted || typeof trusted !== 'object') throw new Error('Trusted circle/member context was not found');
  if (trusted.circleId !== requestedCircleId || trusted.memberId !== requestedMemberId || trusted.round !== round) {
    throw new Error('Trusted circle/member/round context does not match the request');
  }
  if (trusted.circleStatus !== 'ACTIVE' || trusted.memberStatus !== 'ACTIVE' || trusted.roundStatus !== 'OPEN') {
    throw new Error('Circle, member, and round must all be active/open to request a quote');
  }
  const asset = requiredText(originAsset, 'originAsset');
  if (!Array.isArray(trusted.allowedOriginAssets) || !trusted.allowedOriginAssets.includes(asset)) {
    throw new Error('Origin asset is not enabled for this member/circle');
  }
  const registeredRefundTo = trusted.refundAddresses?.[asset];
  if (typeof registeredRefundTo !== 'string' || !registeredRefundTo.trim() || refundTo !== registeredRefundTo) {
    throw new Error('Refund address must match the member wallet registered for the selected origin asset');
  }
  const inputAmount = positiveUnits(amount, 'amount');
  const maxAmount = trusted.maxInputAmounts?.[asset];
  if (typeof maxAmount !== 'string' || !/^[1-9][0-9]*$/.test(maxAmount) || BigInt(inputAmount) > BigInt(maxAmount)) {
    throw new Error('Input amount exceeds the configured limit or has no trusted limit');
  }
  const requiredContributionAmount = positiveUnits(trusted.requiredContributionAmount, 'requiredContributionAmount');
  const memberNearAccount = requiredText(trusted.memberNearAccount, 'memberNearAccount');
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('clock must return a valid Date');
  if (!Number.isSafeInteger(trusted.roundDeadlineMs) || trusted.roundDeadlineMs <= 0) {
    throw new Error('Trusted round deadline is required');
  }
  if (now.getTime() >= trusted.roundDeadlineMs) {
    throw Object.assign(new Error('Round contribution deadline has passed'), { code: 'ROUND_DEADLINE_PASSED' });
  }
  const deadline = new Date(Math.min(now.getTime() + 15 * 60 * 1000, trusted.roundDeadlineMs)).toISOString();
  const request = buildMemberMediatedQuoteRequest({
    originAsset: asset,
    amount: inputAmount,
    memberNearAccount,
    refundTo: registeredRefundTo,
    slippageTolerance,
    deadline,
    depositMode,
  });
  const quote = await quoteClient.getQuote(request);
  if (!quote || quote.originAsset !== request.originAsset || quote.destinationAsset !== request.destinationAsset
      || quote.recipient !== request.recipient || quote.amountIn !== request.amount) {
    throw new Error('1Click quote does not match the trusted member request');
  }
  const minimumAmountOut = positiveUnits(quote.minimumAmountOut, 'quote minimumAmountOut');
  if (BigInt(minimumAmountOut) < BigInt(requiredContributionAmount)) {
    throw new Error('Quoted minimum output is insufficient for the circle contribution amount');
  }
  const intentId = requiredText(idFactory(), 'intentId');
  const intent = store.createPendingIntent({
    intentId,
    depositAddress: requiredText(quote.depositAddress, 'quote depositAddress'),
    ...(quote.depositMemo === undefined ? {} : { depositMemo: requiredText(quote.depositMemo, 'quote depositMemo') }),
    circleId: requestedCircleId,
    memberId: requestedMemberId,
    round,
    destinationAsset: request.destinationAsset,
    recipient: memberNearAccount,
    minimumAmountOut,
    requiredContributionAmount,
    originAsset: asset,
    amountIn: inputAmount,
    quotedAmountOut: positiveUnits(quote.amountOut, 'quote amountOut'),
    quoteDeadline: requiredText(quote.deadline, 'quote deadline'),
    ...(quote.signature === undefined ? {} : { quoteSignature: requiredText(quote.signature, 'quote signature') }),
    ...(quote.correlationId === undefined ? {} : { quoteCorrelationId: requiredText(quote.correlationId, 'quote correlationId') }),
  });
  return Object.freeze({
    intentId: intent.intentId,
    circleId: intent.circleId,
    memberId: intent.memberId,
    round: intent.round,
    depositAddress: intent.depositAddress,
    ...(intent.depositMemo === undefined ? {} : { depositMemo: intent.depositMemo }),
    originAsset: intent.originAsset,
    amountIn: intent.amountIn,
    destinationAsset: intent.destinationAsset,
    recipient: intent.recipient,
    quotedAmountOut: intent.quotedAmountOut,
    minimumAmountOut: intent.minimumAmountOut,
    requiredContributionAmount: intent.requiredContributionAmount,
    deadline: intent.quoteDeadline,
    status: intent.status,
  });
}


/**
 * Build an estimate-only quote for an authenticated member. Unlike
 * createTrustedMemberQuote, this path never receives a settlement store and
 * cannot persist an intent or return deposit instructions.
 */
export async function createTrustedMemberQuotePreview({
  quoteClient, resolveTrustedContext, circleId, memberId, round,
  originAsset, amount, refundTo, slippageTolerance = 100, depositMode = 'SIMPLE',
  clock = () => new Date(),
} = {}) {
  if (!quoteClient || typeof quoteClient.getQuotePreview !== 'function') throw new Error('A 1Click preview client is required');
  if (typeof resolveTrustedContext !== 'function') throw new Error('A trusted circle/member context resolver is required');
  const requestedCircleId = requiredText(circleId, 'circleId');
  const requestedMemberId = requiredText(memberId, 'memberId');
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
  const trusted = await resolveTrustedContext({ circleId: requestedCircleId, memberId: requestedMemberId, round });
  if (!trusted || typeof trusted !== 'object') throw new Error('Trusted circle/member context was not found');
  if (trusted.circleId !== requestedCircleId || trusted.memberId !== requestedMemberId || trusted.round !== round) {
    throw new Error('Trusted circle/member/round context does not match the request');
  }
  if (trusted.circleStatus !== 'ACTIVE' || trusted.memberStatus !== 'ACTIVE' || trusted.roundStatus !== 'OPEN') {
    throw new Error('Circle, member, and round must all be active/open to preview a quote');
  }
  const asset = requiredText(originAsset, 'originAsset');
  if (!Array.isArray(trusted.allowedOriginAssets) || !trusted.allowedOriginAssets.includes(asset)) {
    throw new Error('Origin asset is not enabled for this member/circle');
  }
  const registeredRefundTo = trusted.refundAddresses?.[asset];
  if (typeof registeredRefundTo !== 'string' || !registeredRefundTo.trim() || refundTo !== registeredRefundTo) {
    throw new Error('Refund address must match the member wallet registered for the selected origin asset');
  }
  const inputAmount = positiveUnits(amount, 'amount');
  const maxAmount = trusted.maxInputAmounts?.[asset];
  if (typeof maxAmount !== 'string' || !/^[1-9][0-9]*$/.test(maxAmount) || BigInt(inputAmount) > BigInt(maxAmount)) {
    throw new Error('Input amount exceeds the configured limit or has no trusted limit');
  }
  const memberNearAccount = requiredText(trusted.memberNearAccount, 'memberNearAccount');
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('clock must return a valid Date');
  if (!Number.isSafeInteger(trusted.roundDeadlineMs) || trusted.roundDeadlineMs <= 0) {
    throw new Error('Trusted round deadline is required');
  }
  if (now.getTime() >= trusted.roundDeadlineMs) {
    throw Object.assign(new Error('Round contribution deadline has passed'), { code: 'ROUND_DEADLINE_PASSED' });
  }
  const deadline = new Date(Math.min(now.getTime() + 15 * 60 * 1000, trusted.roundDeadlineMs)).toISOString();
  const request = buildMemberMediatedQuoteRequest({
    originAsset: asset,
    amount: inputAmount,
    memberNearAccount,
    refundTo: registeredRefundTo,
    slippageTolerance,
    deadline,
    depositMode,
    dry: true,
  });
  const quote = await quoteClient.getQuotePreview(request);
  if (!quote || quote.originAsset !== request.originAsset || quote.destinationAsset !== request.destinationAsset
      || quote.recipient !== request.recipient || quote.amountIn !== request.amount) {
    throw new Error('1Click preview does not match the trusted member request');
  }
  const amountOut = positiveUnits(quote.amountOut, 'preview amountOut');
  const minimumAmountOut = positiveUnits(quote.minimumAmountOut, 'preview minimumAmountOut');
  if (BigInt(amountOut) < BigInt(minimumAmountOut)) throw new Error('Preview amountOut is below minimumAmountOut');
  return Object.freeze({
    circleId: requestedCircleId,
    round,
    originAsset: asset,
    amountIn: inputAmount,
    destinationAsset: request.destinationAsset,
    recipient: memberNearAccount,
    estimatedAmountOut: amountOut,
    minimumAmountOut,
    deadline: requiredText(quote.deadline, 'preview deadline'),
    ...(typeof quote.amountOutFormatted === 'string' ? { amountOutFormatted: quote.amountOutFormatted } : {}),
    ...(typeof quote.amountOutUsd === 'string' || (typeof quote.amountOutUsd === 'number' && Number.isFinite(quote.amountOutUsd))
      ? { amountOutUsd: quote.amountOutUsd } : {}),
    ...(typeof quote.timeEstimate === 'number' && Number.isFinite(quote.timeEstimate) && quote.timeEstimate >= 0
      ? { timeEstimate: quote.timeEstimate } : {}),
    ...(typeof quote.correlationId === 'string' ? { correlationId: quote.correlationId } : {}),
    status: 'PREVIEW_ONLY',
    contributionReady: false,
    note: 'Estimate only. Destination is nep141:wrap.near; this is not a native-NEAR contract contribution.',
  });
}
