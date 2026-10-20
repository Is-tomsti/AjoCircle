const DEFAULT_TIMEOUT_MS = 10_000;

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function encodeArgs(args) {
  return Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
}

function decodeViewResult(result) {
  if (!result || !Array.isArray(result.result) || result.result.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('NEAR RPC returned a malformed call_function result');
  }
  const bytes = Buffer.from(result.result);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error('NEAR contract view returned invalid JSON');
  }
}

/** Read-only adapter for the AjoCircle contract's public view methods. */
export class NearContractReadClient {
  constructor({ rpcUrl, contractId, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.rpcUrl = requireNonEmptyString(rpcUrl, 'NEAR RPC URL');
    this.contractId = requireNonEmptyString(contractId, 'NEAR contract account ID');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Timeout must be a positive safe integer');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async view(methodName, args = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'ajocircle-read',
          method: 'query',
          params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: this.contractId,
            method_name: methodName,
            args_base64: encodeArgs(args),
          },
        }),
        signal: controller.signal,
      });
      if (!response || !response.ok) throw new Error(`NEAR RPC HTTP error${response?.status ? ` (${response.status})` : ''}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(`NEAR RPC error: ${payload.error.message ?? 'request failed'}`);
      if (!payload || !Object.hasOwn(payload, 'result')) throw new Error('NEAR RPC response is missing result');
      return decodeViewResult(payload.result);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('NEAR RPC request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getRound() {
    const value = await this.view('get_round');
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('get_round returned an invalid round');
    return value;
  }

  async getContribution({ member } = {}) {
    const account = requireNonEmptyString(member, 'Member NEAR account ID');
    const value = await this.view('get_contribution', { member: account });
    if (value === null) return null;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('get_contribution returned an invalid yoctoNEAR amount');
    return value;
  }

  async isCircleCompleted() {
    return this.#booleanView('is_circle_completed');
  }

  async isPayoutPending() {
    return this.#booleanView('is_payout_pending');
  }

  async isPayoutComplete() {
    return this.#booleanView('is_payout_complete');
  }

  async #booleanView(methodName) {
    const value = await this.view(methodName);
    if (typeof value !== 'boolean') throw new Error(`${methodName} returned a non-boolean value`);
    return value;
  }
}
