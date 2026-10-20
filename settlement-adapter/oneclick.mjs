const API_BASE = 'https://1click.chaindefuser.com';

function valueAt(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const key of path) value = value?.[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function parseOneClickStatus(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('1Click response must be a JSON object');
  }
  const status = valueAt(body, [['status']]);
  const depositAddress = valueAt(body, [
    ['quoteResponse', 'quote', 'depositAddress'], ['quote', 'depositAddress'],
  ]);
  const destinationAsset = valueAt(body, [
    ['quoteResponse', 'request', 'destinationAsset'],
    ['quoteResponse', 'quote', 'request', 'destinationAsset'],
    ['quote', 'request', 'destinationAsset'],
  ]);
  const recipient = valueAt(body, [
    ['quoteResponse', 'request', 'recipient'],
    ['quoteResponse', 'quote', 'request', 'recipient'],
    ['quote', 'request', 'recipient'],
  ]);
  const amountOutText = valueAt(body, [['swapDetails', 'amountOut'], ['amountOut']]);
  if (!status || !depositAddress || !destinationAsset || !recipient || !amountOutText) {
    throw new Error('1Click response is missing required settlement or quote fields');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(amountOutText)) {
    throw new Error('1Click output amount must be an integer base-unit string');
  }
  const txs = body.swapDetails?.destinationChainTxHashes ?? body.destinationChainTxHashes;
  if (!Array.isArray(txs) || txs.some(tx => typeof tx?.hash !== 'string')) {
    throw new Error('1Click response has malformed destination transaction evidence');
  }
  return Object.freeze({
    status,
    depositAddress,
    destinationAsset,
    recipient,
    amountOut: BigInt(amountOutText),
    destinationTxHashes: Object.freeze(txs.map(tx => tx.hash)),
  });
}

export function verifyExpectedDelivery(observed, expected) {
  if (observed.status !== 'SUCCESS') {
    throw new Error(`1Click settlement is not successful: ${observed.status}`);
  }
  if (observed.depositAddress !== expected.depositAddress
      || observed.destinationAsset !== expected.destinationAsset
      || observed.recipient !== expected.recipient) {
    throw new Error('1Click quote does not match the trusted pending-intent record');
  }
  const minimum = BigInt(expected.minimumAmountOut);
  if (observed.amountOut < minimum) {
    throw new Error('Actual destination amount is below the required minimum');
  }
  if (observed.destinationTxHashes.length === 0
      || observed.destinationTxHashes.some(hash => !hash.trim())) {
    throw new Error('Successful status is missing destination transaction evidence');
  }
  return Object.freeze({
    status: observed.status,
    depositAddress: observed.depositAddress,
    destinationAsset: observed.destinationAsset,
    recipient: observed.recipient,
    amountOut: observed.amountOut.toString(),
    destinationTxHashes: [...observed.destinationTxHashes],
  });
}

export class OneClickStatusClient {
  constructor({ bearerToken, fetchImpl = globalThis.fetch, baseUrl = API_BASE } = {}) {
    if (typeof bearerToken !== 'string' || !bearerToken.trim()) {
      throw new Error('A server-side 1Click API credential is required');
    }
    if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is unavailable');
    this.bearerToken = bearerToken;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getStatus({ depositAddress, depositMemo } = {}) {
    if (typeof depositAddress !== 'string' || !depositAddress.trim()) {
      throw new Error('Deposit address must come from a trusted stored quote');
    }
    if (depositMemo !== undefined && (typeof depositMemo !== 'string' || !depositMemo.trim())) {
      throw new Error('Deposit memo cannot be empty when supplied');
    }
    const url = new URL(`${this.baseUrl}/v0/status`);
    url.searchParams.set('depositAddress', depositAddress);
    if (depositMemo !== undefined) url.searchParams.set('depositMemo', depositMemo);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.bearerToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`1Click status endpoint returned HTTP ${response.status}`);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('1Click returned invalid JSON'); }
    return parseOneClickStatus(body);
  }
}
