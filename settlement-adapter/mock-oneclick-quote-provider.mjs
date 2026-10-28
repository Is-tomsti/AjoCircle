/**
 * Deterministic, offline-only 1Click-compatible test double.
 *
 * This module never performs network I/O, never returns deposit instructions,
 * and refuses committed (dry:false) quote requests. It is for unit/integration
 * tests only; do not wire it into the user-facing preview route because its
 * amounts are synthetic and are not market estimates.
 */
function positiveUnits(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Mock quote ${label} must be a positive integer string`);
  }
  return value;
}

function validatePreviewRequest(request) {
  if (!request || typeof request !== 'object' || request.dry !== true) {
    throw new Error('Mock quote provider only supports explicit dry:true preview requests');
  }
  for (const field of ['originAsset', 'destinationAsset', 'amount', 'recipient', 'refundTo', 'deadline']) {
    if (typeof request[field] !== 'string' || !request[field].trim()) {
      throw new Error(`Mock quote request is missing ${field}`);
    }
  }
  positiveUnits(request.amount, 'amount');
}

export class MockOneClickQuoteProvider {
  constructor({ outputAmount = '1000000000000000000000000' } = {}) {
    this.outputAmount = positiveUnits(outputAmount, 'outputAmount');
    Object.freeze(this);
  }

  async getQuotePreview(request) {
    validatePreviewRequest(request);
    // Echo request exactly so the production parser can verify request binding.
    // The output is synthetic and must never be interpreted as a real estimate.
    const output = this.outputAmount;
    return Object.freeze({
      mockOnly: true,
      correlationId: 'mock-preview-no-network',
      quoteRequest: Object.freeze({ ...request }),
      quote: Object.freeze({
        amountIn: request.amount,
        amountOut: output,
        minAmountOut: output,
        amountOutFormatted: 'MOCK ONLY — NOT A MARKET ESTIMATE',
        deadline: request.deadline,
      }),
    });
  }

  async getQuote(request) {
    if (!request || request.dry !== false) {
      throw new Error('Mock committed quotes are disabled; use dry:true for isolated tests');
    }
    throw new Error('Mock provider never creates committed quotes or deposit instructions');
  }
}
