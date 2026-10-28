import { createHash } from 'node:crypto';

export const APPROVED_AJOCIRCLE_TESTNET_SHA256 = '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0';
export const APPROVED_AJOCIRCLE_TESTNET_SHA256S = Object.freeze([
  APPROVED_AJOCIRCLE_TESTNET_SHA256,
  'ff7f5d92a863dedae3eaafdcfced8d9d615c5be8b14b9f949aad65d99341daf3',
  // Reviewed build with guarded expired-round deadline recovery.
  'b1edaeea67c59477155330de826c219e9731361de61a4faf29b28382365b3cf6',
  // Isolated testnet-verified build with contribution_recorded round events (2026-10-24).
  '39e25e33b245cf6b1db3f4f3fbcec074796308d5741e4c058017123bbbc19674',
  // Reviewed protected-public distribution build deployed to isolated testnet account (2026-10-25).
  'f0f587a8e94c6206d6e73bd8a5b493763addcd972ceab33396302fd99f3bd545',
  // Migration-v2 recovery build deployed and finalized on ajo-demo-oct22.testnet (2026-10-27); 62 contract tests passed.
  '233a7bd654fbfb905ac5eb981ef746e19c8d39e858cc31140099891f6c937851',
  // Guarded unstarted-circle repair build deployed and finalized on ajo-demo-oct22.testnet (2026-10-27); 65 contract tests passed and repair verified.
  'd8026ad1de87e1122ed1fe36578f2fe9be1324f1ed4ef4bc576f8b4b1ee70cdf',
]);
export const DEFAULT_NEAR_TESTNET_RPC = 'https://rpc.testnet.fastnear.com';

function accountId(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64
      || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(value)) throw new Error('Invalid NEAR testnet contract account ID');
  return value;
}

function decodeRpcBytes(value, label) {
  if (value && typeof value.error === 'string') {
    throw new Error(`${label}: contract view failed: ${value.error}`);
  }
  if (value && typeof value.result?.error === 'string') {
    throw new Error(`${label}: contract view unavailable: ${value.result.error}`);
  }
  if (!value || !Array.isArray(value.result) || value.result.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`${label}: malformed NEAR RPC result bytes`);
  }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.result));
  try { return JSON.parse(raw); } catch { throw new Error(`${label}: contract view returned invalid JSON`); }
}

async function rpc({ rpcUrl, fetchImpl, params, timeoutMs }) {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let retryableFailure = false;
    try {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ajocircle-contract-verify', method: 'query', params }),
        signal: controller.signal,
      });
      if (!response?.ok) {
        const error = new Error('NEAR RPC HTTP error' + (response?.status ? ' (' + response.status + ')' : ''));
        error.retryable = response?.status === 429 || (response?.status >= 500 && response?.status <= 599);
        throw error;
      }
      const payload = await response.json();
      if (payload?.error) throw new Error('NEAR RPC error: ' + (payload.error.message ?? 'request failed'));
      if (!payload || !Object.hasOwn(payload, 'result')) throw new Error('NEAR RPC response is missing result');
      return payload.result;
    } catch (error) {
      const transportFailure = error?.name === 'AbortError'
        || error?.retryable === true
        || error?.message === 'fetch failed'
        || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH'].includes(error?.cause?.code);
      if (attempt < maxAttempts && transportFailure) {
        retryableFailure = true;
      } else if (error?.name === 'AbortError') {
        throw new Error('NEAR RPC request timed out after retry');
      } else if (transportFailure) {
        throw new Error('NEAR RPC transport failed after retry');
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (retryableFailure) await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('NEAR RPC request failed after retry');
}

async function view({ rpcUrl, fetchImpl, contractId, methodName, timeoutMs }) {
  const result = await rpc({ rpcUrl, fetchImpl, timeoutMs, params: {
    request_type: 'call_function', finality: 'final', account_id: contractId,
    method_name: methodName, args_base64: Buffer.from('{}', 'utf8').toString('base64'),
  } });
  return decodeRpcBytes(result, methodName);
}

/** Read-only testnet verification. It never submits transactions or writes chain state. */
export async function verifyAjoCircleContract({
  contractId, expectedMode, rpcUrl = DEFAULT_NEAR_TESTNET_RPC, fetchImpl = globalThis.fetch,
  expectedSha256, timeoutMs = 10_000,
} = {}) {
  const contract = accountId(contractId);
  if (rpcUrl !== DEFAULT_NEAR_TESTNET_RPC) throw new Error('Contract verification only permits the NEAR testnet RPC');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (!['PROTECTED_PUBLIC', 'PRIVATE_TRUSTED'].includes(expectedMode)) throw new Error('Expected circle mode is invalid');
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256))) throw new Error('Approved contract SHA-256 is invalid');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Timeout must be a positive safe integer');

  const code = await rpc({ rpcUrl, fetchImpl, timeoutMs, params: {
    request_type: 'view_code', finality: 'final', account_id: contract,
  } });
  if (typeof code?.code_base64 !== 'string' || !code.code_base64.length) throw new Error('Contract has no deployed code');
  const wasm = Buffer.from(code.code_base64, 'base64');
  if (!wasm.length || wasm.toString('base64').replace(/=+$/, '') !== code.code_base64.replace(/=+$/, '')) {
    throw new Error('NEAR RPC returned malformed contract code');
  }
  const codeSha256 = createHash('sha256').update(wasm).digest('hex');
  const approvedHashes = expectedSha256 === undefined ? APPROVED_AJOCIRCLE_TESTNET_SHA256S : [expectedSha256.toLowerCase()];
  if (!approvedHashes.includes(codeSha256)) throw new Error('Deployed contract code SHA-256 is not on the approved allowlist');

  const [mode, round, deadline, contributionCount, recipient, completed, payoutPending, payoutComplete, requiredProtection,
    members, memberCount, contributionAmount, payoutOrder, treasurerAgent, roundDeadlines] = await Promise.all([
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_mode', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_round', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_round_deadline', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_contribution_count', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_current_recipient', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'is_circle_completed', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'is_payout_pending', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'is_payout_complete', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_required_protection', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_members', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_member_count', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_contribution_amount', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_payout_order', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_treasurer_agent', timeoutMs }),
    view({ rpcUrl, fetchImpl, contractId: contract, methodName: 'get_round_deadlines', timeoutMs }),
  ]);
  const expectedContractMode = expectedMode === 'PROTECTED_PUBLIC' ? 'ProtectedPublic' : 'Private';
  if (mode !== expectedContractMode) throw new Error('Deployed contract mode does not match the circle policy');
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('Contract returned an invalid round number');
  if (!(typeof deadline === 'string' && /^[1-9][0-9]*$/.test(deadline))) throw new Error('Contract returned an invalid round deadline');
  if (!Number.isSafeInteger(contributionCount) || contributionCount < 0) throw new Error('Contract returned an invalid contribution count');
  if (typeof recipient !== 'string' || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(recipient)) throw new Error('Contract returned an invalid payout recipient');
  if ([completed, payoutPending, payoutComplete].some(value => typeof value !== 'boolean')) throw new Error('Contract returned invalid lifecycle flags');
  if (!(typeof requiredProtection === 'string' && /^(0|[1-9][0-9]*)$/.test(requiredProtection))) throw new Error('Contract returned invalid required-protection amount');
  const validAccount = value => typeof value === 'string' && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(value);
  if (!Array.isArray(members) || members.length < 2 || members.some(member => !validAccount(member))
      || new Set(members).size !== members.length) throw new Error('Contract returned an invalid member list');
  if (!Number.isSafeInteger(memberCount) || memberCount !== members.length) throw new Error('Contract member count does not match the member list');
  if (!(typeof contributionAmount === 'string' && /^[1-9][0-9]*$/.test(contributionAmount))) throw new Error('Contract returned an invalid contribution amount');
  if (!Array.isArray(payoutOrder) || payoutOrder.length !== memberCount
      || payoutOrder.some(member => !validAccount(member) || !members.includes(member))
      || new Set(payoutOrder).size !== payoutOrder.length) throw new Error('Contract returned an invalid payout order');
  if (!validAccount(treasurerAgent)) throw new Error('Contract returned an invalid treasurer account');
  if (!Array.isArray(roundDeadlines) || roundDeadlines.length !== members.length
      || roundDeadlines.some(value => typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) {
    throw new Error('Contract returned an invalid full round schedule');
  }
  const rounds = roundDeadlines.map((deadlineNs, index) => Object.freeze({
    round: index, contributionAmount, deadlineNs,
  }));
  if (roundDeadlines.some((value, index) => index > 0 && BigInt(value) <= BigInt(roundDeadlines[index - 1]))) {
    throw new Error('Contract returned a non-increasing round schedule');
  }
  if (roundDeadlines[round] !== deadline) throw new Error('Current round deadline does not match the full schedule');
  if (payoutOrder[round % payoutOrder.length] !== recipient) throw new Error('Current recipient does not match the configured payout order');

  return Object.freeze({
    verified: true, contractId: contract, network: 'testnet', codeSha256, mode,
    currentRound: round, roundDeadline: String(deadline), contributionCount,
    currentRecipient: recipient, circleCompleted: completed, payoutPending,
    payoutComplete, requiredProtection, members: Object.freeze([...members]), memberCount,
    contributionAmount, payoutOrder: Object.freeze([...payoutOrder]), treasurerAgent,
    rounds: Object.freeze(rounds), roundDeadlines: Object.freeze([...roundDeadlines]),
    verifiedAt: new Date().toISOString(),
    quoteReady: false,
    quoteReadinessReason: 'Verification is read-only. Complete on-chain schedule is available, but it must be compared against the persisted local cycle before quote creation is enabled; quote creation remains blocked.',
  });
}
