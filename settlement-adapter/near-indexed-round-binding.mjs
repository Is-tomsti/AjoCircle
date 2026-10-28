import { createHash } from 'node:crypto';

const DEFAULT_FASTNEAR_TESTNET_TX_API = 'https://tx.test.fastnear.com/v0/transactions';
const ACCOUNT = /^[a-z0-9_.-]+$/;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/** Server-only indexed event verifier. Current deployed contracts emit no round event and are rejected. */
export async function verifyIndexedContributionRoundBinding({
  transactionHash, contractId, signerId, circleId, round, evidence,
  amountYocto = evidence?.amountYocto, blockHash = evidence?.blockHash,
  fetchImpl = globalThis.fetch, endpoint = DEFAULT_FASTNEAR_TESTNET_TX_API,
  apiKey = process.env.FASTNEAR_API_KEY, timeoutMs = 10_000,
} = {}) {
  const required = (v, label) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required`);
    return v.trim();
  };
  const txHash = required(transactionHash, 'transactionHash');
  const contract = required(contractId, 'contractId');
  const signer = required(signerId, 'signerId');
  const circle = required(circleId, 'circleId');
  const expectedBlock = required(blockHash, 'blockHash');
  if (evidence && (evidence.verified !== true || evidence.transactionHash !== txHash
      || evidence.contractId !== contract || evidence.signerId !== signer)) {
    throw new Error('Base transaction evidence does not match the round-binding request');
  }
  if (!HASH.test(txHash) || !HASH.test(expectedBlock)) throw new Error('Transaction or block hash is malformed');
  if (!ACCOUNT.test(contract) || !ACCOUNT.test(signer) || contract.length > 64 || signer.length > 64
      || contract.startsWith('.') || contract.endsWith('.') || contract.includes('..')
      || signer.startsWith('.') || signer.endsWith('.') || signer.includes('..')) {
    throw new Error('Contract or signer account is malformed');
  }
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
  if (typeof amountYocto !== 'string' || !/^[1-9][0-9]*$/.test(amountYocto)) throw new Error('amountYocto must be a positive integer string');
  if (endpoint !== DEFAULT_FASTNEAR_TESTNET_TX_API) throw new Error('Only the configured FastNear testnet transaction indexer is permitted');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive safe integer');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    const headers = { 'content-type': 'application/json' };
    if (typeof apiKey === 'string' && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify({ tx_hashes: [txHash] }), signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`FastNear testnet indexer HTTP error${response?.status ? ` (${response.status})` : ''}`);
    body = await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('FastNear testnet indexer request timed out');
    throw error;
  } finally { clearTimeout(timeout); }

  if (!Array.isArray(body?.transactions) || body.transactions.length !== 1) throw new Error('Indexer did not return exactly one transaction record');
  const record = body.transactions[0];
  const tx = record?.transaction;
  if (!tx || tx.hash !== txHash || tx.signer_id !== signer || tx.receiver_id !== contract) {
    throw new Error('Indexed transaction does not match the trusted hash, signer, and contract');
  }
  if (!Array.isArray(tx.actions) || tx.actions.length !== 1) throw new Error('Indexed contribution must contain exactly one action');
  const action = tx.actions[0]?.FunctionCall;
  if (!action || action.method_name !== 'contribute' || String(action.deposit) !== amountYocto) {
    throw new Error('Indexed transaction is not the exact trusted contribute() action');
  }
  const indexedBlockHash = record?.execution_outcome?.block_hash ?? record?.execution_outcome?.block?.hash ?? record?.block_hash;
  if (indexedBlockHash !== expectedBlock) throw new Error('Indexer transaction block does not match finalized RPC evidence');

  const matches = [];
  for (const receiptRecord of Array.isArray(record.receipts) ? record.receipts : []) {
    const receipt = receiptRecord?.receipt;
    const logs = receiptRecord?.execution_outcome?.outcome?.logs;
    if (receipt?.receiver_id !== contract || !Array.isArray(logs)) continue;
    for (const log of logs) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      let event;
      try { event = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (event?.standard !== 'ajocircle' || event?.version !== '1.0.0'
          || event?.event !== 'contribution_recorded' || !Array.isArray(event.data)) continue;
      for (const item of event.data) {
        if (item?.member_id === signer && item?.round === round && String(item?.amount_yocto) === amountYocto) {
          matches.push({ receiptId: receipt.receipt_id, event: item, log });
        }
      }
    }
  }
  if (matches.length !== 1) throw new Error('A unique on-chain contribution_recorded round event is required; legacy contracts without the event are not accepted');
  const match = matches[0];
  if (typeof match.receiptId !== 'string' || !match.receiptId) throw new Error('Round event is missing its receipt identifier');
  const proofPayload = { network: 'testnet', transactionHash: txHash, contractId: contract, signerId: signer,
    circleId: circle, round, amountYocto, blockHash: expectedBlock, receiptId: match.receiptId, event: match.event, log: match.log };
  const proofDigest = `sha256:${createHash('sha256').update(JSON.stringify(proofPayload)).digest('hex')}`;
  return Object.freeze({ verified: true, network: 'testnet', transactionHash: txHash, contractId: contract,
    signerId: signer, circleId: circle, round, blockHash: expectedBlock,
    proofRef: `fastnear:testnet:tx:${txHash}:receipt:${match.receiptId}`, proofDigest });
}
