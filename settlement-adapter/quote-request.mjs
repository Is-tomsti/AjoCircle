const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};
const units = (value, label) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive base-unit integer string`);
  return value;
};

export function buildMemberMediatedQuoteRequest({
  originAsset, amount, memberNearAccount, refundTo, slippageTolerance = 100,
  deadline, depositMode = 'SIMPLE',
} = {}) {
  if (!Number.isSafeInteger(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 10000) {
    throw new Error('slippageTolerance must be an integer from 0 to 10000 basis points');
  }
  if (!['SIMPLE', 'MEMO'].includes(depositMode)) throw new Error('depositMode must be SIMPLE or MEMO');
  return Object.freeze({
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance,
    originAsset: text(originAsset, 'originAsset'),
    destinationAsset: 'nep141:wrap.near',
    amount: units(amount, 'amount'),
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    recipient: text(memberNearAccount, 'memberNearAccount'),
    refundTo: text(refundTo, 'refundTo'),
    deadline: text(deadline, 'deadline'),
    depositMode,
  });
}
