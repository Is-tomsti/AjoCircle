import { NearContractReadClient } from './near-contract-read-client.mjs';
import { verifyAjoCircleContract } from './near-contract-verification.mjs';
import { compareCircleSchedule } from './contract-schedule-parity.mjs';
import { inspectPayoutReadiness } from './payout-agent-readiness.mjs';

export const PAYOUT_EXECUTION_PLAN_PATH = '/api/agent/payout-plan';

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}
async function readBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body;
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(part, 'utf8');
    if (size > 16 * 1024) throw new Error('BODY_TOO_LARGE');
    raw += part;
  }
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}

async function verifySubmittedPayoutTransaction({ fetchImpl, rpcUrl, plan, txHash }) {
  if (typeof txHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) {
    throw new Error('Transaction hash format is invalid');
  }
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ajocircle-payout-submit-check', method: 'tx', params: [txHash, plan.contractId] }),
  });
  if (!response.ok) throw new Error('NEAR RPC could not verify the submitted transaction');
  const payload = await response.json();
  const result = payload?.result;
  if (payload?.error || !result?.transaction || !result?.status) {
    throw new Error('NEAR RPC did not return finalized transaction evidence');
  }
  const tx = result.transaction;
  if (tx.hash !== txHash || tx.signer_id !== plan.contractId || tx.receiver_id !== plan.contractId) {
    throw new Error('Transaction signer, receiver, or hash does not match the authorized contract');
  }
  const actions = tx.actions;
  if (!Array.isArray(actions) || actions.length !== 1 || !actions[0]?.FunctionCall) {
    throw new Error('Transaction does not contain the single authorized payout function call');
  }
  const call = actions[0].FunctionCall;
  let args;
  try { args = JSON.parse(Buffer.from(call.args ?? '', 'base64').toString('utf8')); } catch {
    throw new Error('Payout function arguments are invalid');
  }
  if (call.method_name !== 'release_payout' || JSON.stringify(args) !== '{}'
      || String(call.deposit ?? '0') !== '0') {
    throw new Error('Transaction does not match release_payout with empty arguments and zero deposit');
  }
  const outcome = result.status;
  if (!(Object.hasOwn(outcome, 'SuccessValue') || Object.hasOwn(outcome, 'SuccessReceiptId'))
      || outcome.Failure || result.transaction_outcome?.outcome?.status?.Failure
      || (Array.isArray(result.receipts_outcome) && result.receipts_outcome.some(item => item?.outcome?.status?.Failure))) {
    throw new Error('The payout transaction has not been verified as successfully executed');
  }
  return Object.freeze({ txHash, signerId: tx.signer_id, receiverId: tx.receiver_id, methodName: call.method_name });
}

/**
 * Authenticated payout plan lifecycle API. Wallet signing stays client-side.
 * Submitted transactions are independently checked against finalized testnet RPC
 * evidence before the durable ledger records the hash.
 */
export function createPayoutExecutionHandler({
  store, executionStore, authenticateRequest, submitPayout,
  rpcUrl = 'https://rpc.testnet.fastnear.com',
  fetchImpl = globalThis.fetch, verifyContract = verifyAjoCircleContract,
  clock = () => Date.now(),
} = {}) {
  if (!store || typeof store.findMembershipForPrincipal !== 'function'
      || typeof store.getVerifiedContractBinding !== 'function'
      || typeof store.getCircleScheduleParityContext !== 'function') throw new Error('Trusted application store is required');
  if (!executionStore || typeof executionStore.prepare !== 'function'
      || typeof executionStore.authorize !== 'function' || typeof executionStore.get !== 'function') {
    throw new Error('Trusted payout execution store is required');
  }
  if (typeof authenticateRequest !== 'function') throw new Error('Trusted request authentication is required');
  if (rpcUrl !== 'https://rpc.testnet.fastnear.com') throw new Error('Payout execution plans are testnet-only');
  if (typeof fetchImpl !== 'function' || typeof verifyContract !== 'function' || typeof clock !== 'function') {
    throw new Error('Payout execution dependencies are invalid');
  }
  const inFlightCliSubmissions = new Set();

  return async function payoutExecutionHandler(request, response) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    let principal;
    try { principal = await authenticateRequest(request); } catch { principal = null; }
    if (!principal || typeof principal.subject !== 'string' || !principal.subject.trim()) {
      return sendJson(response, 401, { error: 'UNAUTHENTICATED' });
    }
    let body;
    try { body = await readBody(request); }
    catch (error) {
      return sendJson(response, error?.message === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['action', 'circleId', 'planId', 'confirmation', 'txHash'].includes(key))
        || !['prepare', 'authorize', 'status', 'recordSubmitted', 'finalize', 'submitCli'].includes(body.action)) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    if (body.action === 'prepare' && (typeof body.circleId !== 'string' || !body.circleId.trim() || body.circleId.length > 200)) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    if (body.action !== 'prepare' && (typeof body.planId !== 'string' || !body.planId.trim())) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    if (body.action === 'recordSubmitted' && (typeof body.txHash !== 'string' || !body.txHash.trim())) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    if (body.action === 'submitCli' && (typeof body.confirmation !== 'string' || body.confirmation.length > 200)) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    const circleId = body.action === 'prepare' ? body.circleId.trim() : undefined;
    const planId = body.planId?.trim();
    const planBefore = body.action === 'prepare' ? null : executionStore.get(planId);
    if (body.action !== 'prepare' && !planBefore) return sendJson(response, 404, { error: 'PAYOUT_PLAN_NOT_FOUND' });
    const authorizedCircleId = circleId ?? planBefore.circleId;
    const membership = store.findMembershipForPrincipal({ principalId: principal.subject, circleId: authorizedCircleId });
    if (!membership || membership.status !== 'ACTIVE') {
      return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
    }

    if (body.action === 'status') {
      return sendJson(response, 200, {
        plan: executionStore.get(planId),
        note: 'Ledger status only. This endpoint does not submit transactions or independently verify payout completion.',
      });
    }

    if (body.action === 'submitCli') {
      if (typeof submitPayout !== 'function') {
        return sendJson(response, 503, { error: 'CLI_PAYOUT_SIGNER_UNAVAILABLE', message: 'The local NEAR CLI signer is not configured. No transaction was submitted.' });
      }
      const submitParityContext = store.getCircleScheduleParityContext({ circleId: authorizedCircleId });
      if (submitParityContext?.local?.mode !== 'PRIVATE_TRUSTED') {
        return sendJson(response, 409, { error: 'PUBLIC_PROPORTIONAL_DISTRIBUTION_REQUIRED', message: 'The rotating release_payout flow is private-circle only. Public circles require a separately verified whole-circle proportional distribution plan. No transaction was submitted.' });
      }
      if (planBefore.state !== 'AUTHORIZED' || planBefore.network !== 'testnet') {
        return sendJson(response, 409, { error: 'PAYOUT_PLAN_NOT_AUTHORIZED', message: 'Only the existing authorized testnet plan can be submitted.' });
      }
      const expectedConfirmation = `SUBMIT TESTNET PAYOUT ${planBefore.contractId} ROUND ${planBefore.round}`;
      if (body.confirmation !== expectedConfirmation) {
        return sendJson(response, 409, { error: 'PAYOUT_CONFIRMATION_MISMATCH', message: 'The exact app confirmation phrase does not match this plan. No transaction was submitted.' });
      }
      if (inFlightCliSubmissions.has(planId)) {
        return sendJson(response, 409, { error: 'PAYOUT_SUBMISSION_ALREADY_IN_PROGRESS', message: 'A submission attempt for this exact plan is already in progress. Do not retry.' });
      }
      inFlightCliSubmissions.add(planId);
      try {
      const binding = store.getVerifiedContractBinding({ circleId: authorizedCircleId });
      const parityContext = store.getCircleScheduleParityContext({ circleId: authorizedCircleId });
      if (!binding || binding.network !== 'testnet' || binding.contractId !== planBefore.contractId
          || binding.codeSha256 !== planBefore.codeSha256 || !parityContext?.ready || !parityContext.local
          || parityContext.local.contractId !== planBefore.contractId) {
        return sendJson(response, 409, { error: 'PAYOUT_BINDING_NOT_VERIFIED', message: 'The stored contract binding or schedule parity does not match the authorized plan. No transaction was submitted.' });
      }
      let submitted = false;
      let submission = null;
      try {
        const live = await verifyContract({
          contractId: planBefore.contractId, expectedMode: parityContext.local.mode, rpcUrl, fetchImpl,
        });
        const ageMs = clock() - Date.parse(live?.verifiedAt ?? '');
        const parity = compareCircleSchedule({ local: parityContext.local, onChain: live });
        if (live?.verified !== true || live.network !== 'testnet' || live.contractId !== planBefore.contractId
            || live.codeSha256 !== planBefore.codeSha256 || live.mode !== binding.mode
            || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 60_000 || !parity.matches) {
          return sendJson(response, 409, { error: 'PAYOUT_LIVE_BINDING_MISMATCH', message: 'Fresh finalized contract code or schedule parity does not match this plan. No transaction was submitted.' });
        }
        const readiness = await inspectPayoutReadiness(
          new NearContractReadClient({ rpcUrl, contractId: planBefore.contractId, fetchImpl }),
          { contractId: planBefore.contractId, network: 'testnet', bindingVerified: true, nowMs: clock() },
        );
        if (readiness.status !== 'ready' || readiness.round !== planBefore.round
            || readiness.recipient !== planBefore.recipient || readiness.potYocto !== planBefore.amountYocto
            || readiness.payoutPending === true || readiness.payoutComplete === true) {
          return sendJson(response, 409, { error: 'PAYOUT_READINESS_MISMATCH', message: 'Fresh on-chain readiness does not exactly match the authorized round, recipient, amount, or lifecycle. No transaction was submitted.', readiness });
        }

        try {
          submission = await submitPayout(planBefore);
          submitted = true;
        } catch (error) {
          if (error?.submissionOutcomeUnknown === true) {
            executionStore.recordUnknown(planId, 'NEAR CLI was invoked but returned no definitive transaction evidence; reconcile before retrying.');
            return sendJson(response, 202, { plan: executionStore.get(planId), status: 'UNKNOWN', transactionSubmitted: 'UNKNOWN', message: 'The CLI submission outcome is uncertain. Do not retry. Reconcile the exact contract and transaction state first.' });
          }
          throw error;
        }
        submitted = true;
        const evidence = await verifySubmittedPayoutTransaction({
          fetchImpl, rpcUrl, plan: planBefore, txHash: submission.txHash,
        });
        const plan = executionStore.recordSubmitted(planId, evidence.txHash);
        return sendJson(response, 200, {
          plan, transactionEvidence: evidence, transactionSubmitted: true,
          signerPublicKey: submission.signerPublicKey,
          note: 'The local NEAR CLI keychain submitted the exact release_payout call after fresh server-side verification. The transaction hash was independently checked against testnet RPC; payout completion still requires finality verification.',
        });
      } catch (error) {
        if (submitted) {
          try { executionStore.recordUnknown(planId, 'A CLI payout submission occurred but independent transaction verification failed; reconcile before retrying.', submission?.txHash ?? null); } catch {}
          return sendJson(response, 202, { plan: executionStore.get(planId), status: 'UNKNOWN', transactionSubmitted: 'UNKNOWN', message: error.message || 'Submission occurred but verification failed. Do not retry.' });
        }
        return sendJson(response, 503, { error: 'CLI_PAYOUT_PREFLIGHT_FAILED', message: error.message || 'Local CLI signer preflight failed. No transaction was submitted.' });
      }
      } finally {
        inFlightCliSubmissions.delete(planId);
      }
    }

    if (body.action === 'recordSubmitted') {
      if (planBefore.state !== 'AUTHORIZED') {
        return sendJson(response, 409, { error: 'PAYOUT_PLAN_NOT_AUTHORIZED', message: 'Only an authorized payout plan can record a submitted transaction.' });
      }
      try {
        const evidence = await verifySubmittedPayoutTransaction({
          fetchImpl, rpcUrl, plan: planBefore, txHash: body.txHash,
        });
        const plan = executionStore.recordSubmitted(planId, evidence.txHash);
        return sendJson(response, 200, {
          plan, transactionEvidence: evidence,
          note: 'NEAR testnet RPC independently verified the release_payout transaction. Payout completion still requires a separate on-chain lifecycle check.',
        });
      } catch (error) {
        return sendJson(response, 409, {
          error: 'PAYOUT_SUBMISSION_NOT_VERIFIED',
          message: error.message || 'The submitted transaction could not be independently verified. Do not retry until its status is reconciled.',
        });
      }
    }

    if (body.action === 'finalize') {
      if (!['SUBMITTED', 'UNKNOWN'].includes(planBefore.state) || !planBefore.txHash) {
        return sendJson(response, 409, {
          error: 'PAYOUT_TRANSACTION_HASH_REQUIRED',
          message: 'A verified transaction hash must be recorded before finality can be checked. Do not retry a payout with an uncertain outcome.',
        });
      }
      const binding = store.getVerifiedContractBinding({ circleId: authorizedCircleId });
      const parityContext = store.getCircleScheduleParityContext({ circleId: authorizedCircleId });
      const expectedMode = parityContext?.local?.mode;
      if (!binding || binding.network !== 'testnet'
          || binding.contractId !== planBefore.contractId
          || binding.codeSha256 !== planBefore.codeSha256
          || !parityContext?.ready || !parityContext.local
          || parityContext.local.contractId !== planBefore.contractId
          || !['PROTECTED_PUBLIC', 'PRIVATE_TRUSTED'].includes(expectedMode)) {
        return sendJson(response, 409, {
          error: 'PAYOUT_FINALITY_POLICY_UNAVAILABLE',
          message: 'The persisted circle policy, verified contract binding, or local schedule is unavailable or does not match this payout plan. Do not retry the transaction.',
        });
      }
      try {
        const transactionEvidence = await verifySubmittedPayoutTransaction({
          fetchImpl, rpcUrl, plan: planBefore, txHash: planBefore.txHash,
        });
        const live = await verifyContract({
          contractId: planBefore.contractId, expectedMode, rpcUrl, fetchImpl,
        });
        if (live?.verified !== true || live.network !== 'testnet'
            || live.contractId !== planBefore.contractId || live.codeSha256 !== planBefore.codeSha256) {
          return sendJson(response, 409, {
            error: 'PAYOUT_FINALITY_NOT_VERIFIED',
            message: 'The current finalized contract code does not match the authorized payout plan.',
          });
        }
        const client = new NearContractReadClient({
          rpcUrl, contractId: planBefore.contractId, fetchImpl,
        });
        const [round, payoutPending, payoutComplete, circleCompleted] = await Promise.all([
          client.view('get_round'),
          client.view('is_payout_pending'),
          client.view('is_payout_complete'),
          client.view('is_circle_completed'),
        ]);
        if (round !== planBefore.round) {
          return sendJson(response, 409, {
            error: 'PAYOUT_ROUND_CHANGED',
            message: 'The on-chain round differs from the authorized plan. Stop and reconcile the lifecycle manually.',
            onChainRound: round, plannedRound: planBefore.round,
          });
        }
        if (payoutPending === true) {
          return sendJson(response, 200, {
            plan: executionStore.get(planId), status: 'PAYOUT_PENDING',
            transactionEvidence,
            note: 'The release transaction is verified, but the contract callback has not finalized the payout. Do not submit again.',
          });
        }
        if (payoutComplete !== true) {
          return sendJson(response, 409, {
            error: 'PAYOUT_NOT_COMPLETE',
            transactionEvidence,
            payoutPending, payoutComplete, circleCompleted,
            message: 'The transaction exists but the contract does not confirm payout completion. Do not retry or advance the round; reconcile this transaction.',
          });
        }
        const plan = executionStore.recordFinalized(planId, {
          txHash: planBefore.txHash,
          finalityVerified: true,
          outcome: 'SUCCESS',
          evidenceReference: `near-testnet:${planBefore.contractId}:${planBefore.txHash}:payout_complete=true:round=${round}:verifiedAt=${clock()}`,
        });
        return sendJson(response, 200, {
          plan, status: 'FINALIZED', transactionEvidence,
          payoutLifecycle: { round, payoutPending, payoutComplete, circleCompleted },
          note: 'The transaction and finalized contract payout-complete state were independently verified.',
        });
      } catch (error) {
        return sendJson(response, 503, {
          error: 'PAYOUT_FINALITY_CHECK_UNAVAILABLE',
          message: error.message || 'Could not independently verify payout finality. Do not retry the transaction.',
        });
      }
    }

    if (body.action === 'authorize') {
      const authorizationContext = store.getCircleScheduleParityContext({ circleId: authorizedCircleId });
      if (authorizationContext?.local?.mode !== 'PRIVATE_TRUSTED') {
        return sendJson(response, 409, { error: 'PUBLIC_PROPORTIONAL_DISTRIBUTION_REQUIRED', message: 'Public circles cannot authorize a rotating payout plan.' });
      }
      try {
        const plan = executionStore.authorize(planId, {
          actor: principal.subject,
          confirmation: body.confirmation,
        });
        return sendJson(response, 200, {
          plan,
          note: 'Authorization recorded. No wallet signing or blockchain transaction was performed.',
        });
      } catch (error) {
        return sendJson(response, 409, { error: 'PAYOUT_PLAN_TRANSITION_REJECTED', message: error.message });
      }
    }

    const binding = store.getVerifiedContractBinding({ circleId });
    const parityContext = store.getCircleScheduleParityContext({ circleId });
    if (parityContext?.local?.mode !== 'PRIVATE_TRUSTED') {
      return sendJson(response, 409, { error: 'PUBLIC_PROPORTIONAL_DISTRIBUTION_REQUIRED', message: 'The rotating release_payout flow is private-circle only. Public circles require a separate whole-circle proportional distribution plan.' });
    }
    if (!binding || binding.network !== 'testnet' || !binding.contractId || !binding.codeSha256
        || !parityContext?.ready || !parityContext.local
        || parityContext.local.contractId !== binding.contractId) {
      return sendJson(response, 409, { error: 'PAYOUT_READINESS_NOT_VERIFIED',
        message: 'A persisted verified testnet binding and local schedule parity are required.' });
    }
    try {
      const live = await verifyContract({
        contractId: binding.contractId, expectedMode: parityContext.local.mode, rpcUrl, fetchImpl,
      });
      const ageMs = clock() - Date.parse(live.verifiedAt);
      const parity = compareCircleSchedule({ local: parityContext.local, onChain: live });
      if (live.verified !== true || live.network !== 'testnet'
          || live.contractId !== binding.contractId || live.codeSha256 !== binding.codeSha256
          || live.mode !== binding.mode || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 60_000
          || !parity.matches) {
        return sendJson(response, 409, { error: 'PAYOUT_READINESS_NOT_VERIFIED',
          message: 'Fresh finalized contract evidence does not match the approved binding and saved schedule.' });
      }
      const readiness = await inspectPayoutReadiness(
        new NearContractReadClient({ rpcUrl, contractId: binding.contractId, fetchImpl }),
        { contractId: binding.contractId, network: 'testnet', bindingVerified: true, nowMs: clock() },
      );
      if (readiness.status !== 'ready') {
        return sendJson(response, 409, { error: 'PAYOUT_NOT_READY', readiness });
      }
      const plan = executionStore.prepare({
        circleId,
        preparedBy: principal.subject,
        readiness: {
          status: readiness.status, transactionSubmitted: false, network: 'testnet',
          contractId: binding.contractId, recipient: readiness.recipient, round: readiness.round,
          codeSha256: live.codeSha256, bindingVerified: true,
          // Contract release_payout transfers contribution amount × total members, even when
          // protected reserve covers a shortfall. This comes from verified contract views.
          amountYocto: readiness.potYocto,
        },
      });
      return sendJson(response, 200, {
        plan,
        readiness: {
          status: readiness.status, round: readiness.round, recipient: readiness.recipient,
          memberCount: readiness.memberCount, contributionCount: readiness.contributionCount,
          missingCount: readiness.missingCount, potYocto: readiness.potYocto,
          deadlineNs: readiness.deadlineNs,
        },
        transactionSubmitted: false,
        note: 'Prepared a durable plan only. No signing, payout submission, or funds movement occurred.',
      });
    } catch {
      return sendJson(response, 503, {
        error: 'PAYOUT_PREFLIGHT_UNAVAILABLE',
        message: 'Fresh finalized contract state could not be verified safely. No transaction was submitted.',
      });
    }
  };
}
