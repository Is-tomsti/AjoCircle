import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const PUBLIC_KEY_RE = /(?:ed25519|secp256k1):[A-Za-z0-9]+/;
const TX_HASH_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,64})\b/;

async function readFullAccessKeys({ fetchImpl, rpcUrl, contractId }) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'ajocircle-cli-signer-check', method: 'query',
      params: { request_type: 'view_access_key_list', finality: 'final', account_id: contractId },
    }),
  });
  if (!response.ok) throw new Error('NEAR RPC could not verify the signer access key');
  const payload = await response.json();
  if (payload?.error || !Array.isArray(payload?.result?.keys)) {
    throw new Error('NEAR RPC did not return finalized access-key evidence');
  }
  return payload.result.keys
    .filter(item => item?.access_key?.permission === 'FullAccess')
    .map(item => item.public_key)
    .filter(key => typeof key === 'string');
}

/**
 * Signs only the fixed release_payout() call for a caller-preflighted testnet plan.
 * Never reads, prints, stores, or accepts a private key. The NEAR CLI keychain remains
 * the signing boundary. The caller must have already verified plan authorization,
 * live contract code, schedule parity, readiness, and the exact payout details.
 */
export function createNearCliPayoutSubmitter({
  fetchImpl = globalThis.fetch,
  rpcUrl = 'https://rpc.testnet.fastnear.com',
  execFileImpl = execFile,
  timeoutMs = 120_000,
} = {}) {
  if (rpcUrl !== 'https://rpc.testnet.fastnear.com') throw new Error('CLI payout submission is testnet-only');
  if (typeof fetchImpl !== 'function' || typeof execFileImpl !== 'function') {
    throw new Error('CLI payout submission dependencies are invalid');
  }
  return async function submitAuthorizedPayout(plan) {
    if (!plan || plan.network !== 'testnet' || !/^[a-z0-9._-]{2,64}$/.test(plan.contractId ?? '')) {
      throw new Error('An authorized testnet contract plan is required');
    }

    const keyResult = await execFileImpl('near', [
      'account', 'get-public-key', 'from-keychain', plan.contractId,
      'network-config', 'testnet',
    ], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const keyText = String(keyResult?.stdout ?? '') + '\n' + String(keyResult?.stderr ?? '');
    const publicKey = keyText.match(PUBLIC_KEY_RE)?.[0];
    if (!publicKey) throw new Error('NEAR CLI keychain did not return a signer public key');
    const fullAccessKeys = await readFullAccessKeys({ fetchImpl, rpcUrl, contractId: plan.contractId });
    if (!fullAccessKeys.includes(publicKey)) {
      throw new Error('The NEAR CLI keychain public key is not a finalized FullAccess key for this exact contract');
    }

    // This command is intentionally fixed: no browser-supplied method, arguments,
    // receiver, deposit, gas, network, account, or signer key can alter the call.
    const args = [
      'contract', 'call-function', 'as-transaction', plan.contractId,
      'release_payout', 'json-args', '{}',
      'prepaid-gas', '300 TGas', 'attached-deposit', '0 NEAR',
      'sign-as', plan.contractId, 'network-config', 'testnet',
      'sign-with-keychain', '--signer-public-key', publicKey, 'send',
    ];
    let result;
    try {
      result = await execFileImpl('near', args, {
        timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      error.submissionOutcomeUnknown = true;
      throw error;
    }
    const output = String(result?.stdout ?? '') + '\n' + String(result?.stderr ?? '');
    const txHash = output.match(/transaction\s*(?:id|hash)\s*:\s*([1-9A-HJ-NP-Za-km-z]{32,64})/i)?.[1]
      ?? output.match(/explorer\.near\.org\/transactions\/([1-9A-HJ-NP-Za-km-z]{32,64})/i)?.[1];
    if (!txHash) {
      // The caller must treat a missing hash after invocation as UNKNOWN and must not retry.
      const error = new Error('NEAR CLI returned without a recognizable transaction hash; submission outcome must be reconciled before any retry');
      error.submissionOutcomeUnknown = true;
      throw error;
    }
    return Object.freeze({ txHash, signerPublicKey: publicKey });
  };
}
