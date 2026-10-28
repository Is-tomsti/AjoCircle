import { createHash } from 'node:crypto';
import { APPROVED_AJOCIRCLE_TESTNET_SHA256S, DEFAULT_NEAR_TESTNET_RPC } from './near-contract-verification.mjs';

const accountPattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function account(value, label) {
  const v = required(value, label);
  if (v.length > 64 || !accountPattern.test(v)) throw new Error(`${label} is invalid`);
  return v;
}
function positiveInteger(value, label) {
  const v = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${label} must be an integer base-unit string`);
  return BigInt(v);
}
async function rpc({ fetchImpl, rpcUrl, method, params, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ajocircle-reputation-evidence', method, params }),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`NEAR RPC HTTP error${response?.status ? ` (${response.status})` : ''}`);
    let body;
    if (typeof response.text === 'function') {
      const raw = await response.text();
      // Preserve u64 nanosecond timestamps as strings instead of lossy JS numbers.
      const normalized = raw.replace(/("timestamp_nanosec"\s*:\s*)([0-9]+)/, '$1"$2"');
      body = JSON.parse(normalized);
    } else {
      body = await response.json();
    }
    if (body?.error) throw new Error(`NEAR RPC error: ${body.error.message ?? 'request failed'}`);
    if (!body || !Object.hasOwn(body, 'result')) throw new Error('NEAR RPC response is missing result');
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('NEAR RPC request timed out');
    throw error;
  } finally { clearTimeout(timeout); }
}

/**
 * Read-only verifier for a finalized native-NEAR contribute() transaction.
 * Expected member/circle/round/amount/deadline must come from trusted server records,
 * never from a browser request. Does not infer missed/default outcomes.
 */
export async function verifyNearContributionEvidence({
  transactionHash, signerId, contractId, expectedAmountYocto, expectedDeadlineNs,
  rpcUrl = DEFAULT_NEAR_TESTNET_RPC, fetchImpl = globalThis.fetch, timeoutMs = 10_000,
  approvedCodeHashes = APPROVED_AJOCIRCLE_TESTNET_SHA256S,
} = {}) {
  const txHash = required(transactionHash, 'transactionHash');
  if (!hashPattern.test(txHash)) throw new Error('transactionHash is malformed');
  const signer = account(signerId, 'signerId');
  const contract = account(contractId, 'contractId');
  if (rpcUrl !== DEFAULT_NEAR_TESTNET_RPC) throw new Error('Evidence verification only permits the NEAR testnet RPC');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Timeout must be a positive safe integer');
  if (!Array.isArray(approvedCodeHashes) || !approvedCodeHashes.length
      || approvedCodeHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))) {
    throw new Error('An explicit approved contract code-hash allowlist is required');
  }
  const amount = positiveInteger(expectedAmountYocto, 'expectedAmountYocto');
  if (amount <= 0n) throw new Error('expectedAmountYocto must be positive');
  const deadline = positiveInteger(expectedDeadlineNs, 'expectedDeadlineNs');

  // Current deployed code is checked against the project allowlist. This does not
  // cryptographically prove which code was deployed at the historical transaction block.
  const code = await rpc({ fetchImpl, rpcUrl, timeoutMs, method: 'query', params: {
    request_type: 'view_code', finality: 'final', account_id: contract,
  } });
  if (typeof code?.code_base64 !== 'string' || !code.code_base64) throw new Error('Contract has no deployed code');
  const wasm = Buffer.from(code.code_base64, 'base64');
  if (!wasm.length || wasm.toString('base64').replace(/=+$/, '') !== code.code_base64.replace(/=+$/, '')) {
    throw new Error('NEAR RPC returned malformed contract code');
  }
  const codeSha256 = createHash('sha256').update(wasm).digest('hex');
  if (!approvedCodeHashes.map(hash => hash.toLowerCase()).includes(codeSha256)) {
    throw new Error('Deployed contract code SHA-256 is not on the approved allowlist');
  }

  const tx = await rpc({ fetchImpl, rpcUrl, timeoutMs, method: 'tx', params: [txHash, signer] });
  if (tx?.final_execution_status !== 'FINAL') throw new Error('Transaction is not finalized');
  if (tx?.transaction?.hash !== txHash) throw new Error('RPC transaction hash does not match the requested evidence');
  if (tx?.transaction?.signer_id !== signer) throw new Error('Transaction signer does not match the trusted member');
  if (tx?.transaction?.receiver_id !== contract) throw new Error('Transaction receiver does not match the registered contract');
  if (!Array.isArray(tx?.transaction?.actions) || tx.transaction.actions.length !== 1) {
    throw new Error('Contribution transaction must contain exactly one action');
  }
  const action = tx.transaction.actions[0]?.FunctionCall;
  if (!action || action.method_name !== 'contribute') throw new Error('Transaction is not a contribute() function call');
  // contribute() takes no arguments. Verify the serialized args instead of
  // accepting arbitrary payloads as contribution evidence.
  if (typeof action.args !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(action.args)) {
    throw new Error('Contribution call arguments are malformed');
  }
  const decodedArgs = Buffer.from(action.args, 'base64');
  if (decodedArgs.toString('base64') !== action.args) throw new Error('Contribution call arguments are malformed');
  let parsedArgs;
  try { parsedArgs = JSON.parse(decodedArgs.toString('utf8')); }
  catch { throw new Error('Contribution call arguments are malformed'); }
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs) || Object.keys(parsedArgs).length !== 0) {
    throw new Error('contribute() must use an empty JSON object as arguments');
  }
  if (positiveInteger(action.deposit, 'transaction deposit') !== amount) {
    throw new Error('Transaction deposit does not match the trusted contribution amount');
  }
  if (tx.status?.Failure || !tx.status || !Object.hasOwn(tx.status, 'SuccessValue')) {
    throw new Error('Contribution transaction execution did not succeed');
  }
  const blockHash = tx.transaction_outcome?.block_hash;
  if (typeof blockHash !== 'string' || !blockHash) throw new Error('Finalized transaction is missing its block hash');
  const block = await rpc({ fetchImpl, rpcUrl, timeoutMs, method: 'block', params: { block_id: blockHash } });
  if (block?.header?.hash !== blockHash || !Number.isSafeInteger(block?.header?.timestamp_nanosec)
      && !(typeof block?.header?.timestamp_nanosec === 'string' && /^[0-9]+$/.test(block.header.timestamp_nanosec))) {
    throw new Error('Finalized block timestamp response is malformed');
  }
  const timestampNs = BigInt(block.header.timestamp_nanosec);
  if (timestampNs > deadline) throw new Error('Transaction was finalized after the configured deadline; classify only under the trusted grace-period policy');
  const digest = createHash('sha256').update(JSON.stringify({
    network: 'testnet', transactionHash: txHash, signerId: signer, contractId: contract,
    method: action.method_name, deposit: amount.toString(), blockHash, timestampNs: timestampNs.toString(), codeSha256,
  })).digest('hex');
  return Object.freeze({
    verified: true, digest: `sha256:${digest}`, evidenceRef: `near:testnet:tx:${txHash}`,
    network: 'testnet', transactionHash: txHash, signerId: signer, contractId: contract,
    method: action.method_name, amountYocto: amount.toString(), blockHash,
    blockTimestampNs: timestampNs.toString(), deadlineNs: deadline.toString(),
    outcome: 'ON_TIME', codeSha256,
  });
}
