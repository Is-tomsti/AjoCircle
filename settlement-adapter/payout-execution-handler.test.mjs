import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayoutExecutionHandler } from './payout-execution-handler.mjs';

const CONTRACT = 'ajo-demo-fresh.testnet';
const CIRCLE = 'circle-testnet-active';
const HASH = '39e25e33b245cf6b1db3f4f3fbcec074796308d5741e4c058017123bbbc19674';
const MEMBERS = ['ajotest1.testnet', 'ajotest2.testnet', 'ajotest3.testnet'];

function fixture({ contributionCount = 0, deadlineOffsetMs = 24 * 60 * 60_000, mode = 'PRIVATE_TRUSTED' } = {}) {
  const now = Date.now();
  const deadlines = [now + deadlineOffsetMs - 24 * 60 * 60_000, now + deadlineOffsetMs, now + deadlineOffsetMs + 24 * 60 * 60_000]
    .map(ms => (BigInt(ms) * 1_000_000n).toString());
  const local = {
    contractId: CONTRACT, mode, members: [...MEMBERS], payoutOrder: [...MEMBERS],
    treasurerAgent: CONTRACT, currentRound: 1, roundDeadlineNs: deadlines[1],
    contributionAmount: '1000000000000000000000000',
    rounds: deadlines.map((deadlineNs, round) => ({ round, contributionAmount: '1000000000000000000000000', deadlineNs })),
  };
  const live = {
    verified: true, network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: mode === 'PRIVATE_TRUSTED' ? 'Private' : 'ProtectedPublic',
    members: [...MEMBERS], payoutOrder: [...MEMBERS], treasurerAgent: CONTRACT, currentRound: 1,
    currentRecipient: MEMBERS[1], contributionAmount: local.contributionAmount, roundDeadline: deadlines[1],
    rounds: deadlines.map((deadlineNs, round) => ({ round, contributionAmount: local.contributionAmount, deadlineNs })),
    circleCompleted: false, payoutPending: false, payoutComplete: false, verifiedAt: new Date(now).toISOString(),
  };
  const views = {
    get_round: 1,
    get_round_deadline: deadlines[1],
    get_round_deadlines: deadlines,
    get_members: [...MEMBERS],
    get_payout_order: [...MEMBERS],
    get_current_recipient: MEMBERS[1],
    get_contribution_amount: local.contributionAmount,
    get_contribution_count: contributionCount,
    get_mode: mode === 'PRIVATE_TRUSTED' ? 'Private' : 'ProtectedPublic',
    get_required_protection: '3000000000000000000000000',
    get_protection_balance: '0',
    get_treasurer_agent: CONTRACT,
    is_payout_pending: false,
    is_payout_complete: false,
    is_circle_completed: false,
  };
  const store = {
    findMembershipForPrincipal: () => ({ status: 'ACTIVE' }),
    getVerifiedContractBinding: () => ({ network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: mode === 'PRIVATE_TRUSTED' ? 'Private' : 'ProtectedPublic' }),
    getCircleScheduleParityContext: () => ({ ready: true, local }),
  };
  const prepared = [];
  const executionStore = {
    prepare: plan => { prepared.push(plan); return { id: 'plan-test-1', state: 'PREPARED', ...plan }; },
    authorize: () => { throw new Error('not expected in this test'); },
    get: () => null,
  };
  // Encode known view values as NEAR JSON-RPC results for deterministic, read-only tests.
  const handlerWithViews = createPayoutExecutionHandler({
    store, executionStore,
    authenticateRequest: async () => ({ subject: 'ajotest1.testnet' }),
    rpcUrl: 'https://rpc.testnet.fastnear.com',
    fetchImpl: async (_url, options) => {
      const method = JSON.parse(options.body).params.method_name;
      const bytes = Buffer.from(JSON.stringify(views[method]), 'utf8');
      return { ok: true, async json() { return { result: { result: [...bytes] } }; } };
    },
    verifyContract: async () => live,
    clock: () => now,
  });
  return { handler: handlerWithViews, prepared, local, live, views };
}

async function invoke(handler, body) {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; },
  };
  await handler({ method: 'POST', body }, response);
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(response.body) };
}

test('private payout preparation blocks a contribution shortfall before the deadline', async () => {
  const f = fixture({ contributionCount: 0, deadlineOffsetMs: 24 * 60 * 60_000 });
  const result = await invoke(f.handler, { action: 'prepare', circleId: CIRCLE });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'PAYOUT_NOT_READY');
  assert.equal(result.body.readiness.status, 'blocked');
  assert.equal(result.body.readiness.deadlinePassed, false);
  assert.equal(f.prepared.length, 0);
});

test('payout preparation records only a durable plan when all contributions are present', async () => {
  const f = fixture({ contributionCount: 3, deadlineOffsetMs: 24 * 60 * 60_000 });
  const result = await invoke(f.handler, { action: 'prepare', circleId: CIRCLE });
  assert.equal(result.status, 200);
  assert.equal(result.body.plan.state, 'PREPARED');
  assert.equal(result.body.transactionSubmitted, false);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.prepared[0].readiness.amountYocto, '3000000000000000000000000');
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('payout preparation fails closed when persisted schedule parity is not ready', async () => {
  const f = fixture({ contributionCount: 3 });
  f.handler = createPayoutExecutionHandler({
    store: {
      findMembershipForPrincipal: () => ({ status: 'ACTIVE' }),
      getVerifiedContractBinding: () => ({ network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic' }),
      getCircleScheduleParityContext: () => ({ ready: false, reason: 'schedule mismatch', local: { mode: 'PRIVATE_TRUSTED' } }),
    },
    executionStore: { prepare: () => { throw new Error('must not prepare'); }, authorize() {}, get() {} },
    authenticateRequest: async () => ({ subject: 'ajotest1.testnet' }),
  });
  const result = await invoke(f.handler, { action: 'prepare', circleId: CIRCLE });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'PAYOUT_READINESS_NOT_VERIFIED');
});

test('records submitted payout only after finalized RPC verifies exact release_payout transaction', async () => {
  const txHash = '11111111111111111111111111111111111111111111';
  const plan = {
    id: 'plan-test-1', state: 'AUTHORIZED', network: 'testnet', circleId: CIRCLE,
    contractId: CONTRACT, codeSha256: HASH, round: 1, recipient: MEMBERS[1],
    amountYocto: '3000000000000000000000000',
  };
  let recorded = null;
  const handler = createPayoutExecutionHandler({
    store: {
      findMembershipForPrincipal: () => ({ status: 'ACTIVE' }),
      getVerifiedContractBinding: () => ({ network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic' }),
      getCircleScheduleParityContext: () => ({ ready: true, local: {} }),
    },
    executionStore: {
      get: () => plan,
      prepare() { throw new Error('not expected'); },
      authorize() { throw new Error('not expected'); },
      recordSubmitted(id, hash) { recorded = { ...plan, id, txHash: hash, state: 'SUBMITTED' }; return recorded; },
    },
    authenticateRequest: async () => ({ subject: 'ajotest3.testnet' }),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'tx');
      assert.deepEqual(request.params, [txHash, CONTRACT]);
      return {
        ok: true,
        async json() {
          return { result: {
            transaction: {
              hash: txHash, signer_id: CONTRACT, receiver_id: CONTRACT,
              actions: [{ FunctionCall: { method_name: 'release_payout', args: 'e30=', deposit: '0', gas: '300000000000000' } }],
            },
            status: { SuccessValue: '' },
            transaction_outcome: { outcome: { status: { SuccessValue: '' } } },
            receipts_outcome: [],
          } };
        },
      };
    },
  });
  const result = await invoke(handler, { action: 'recordSubmitted', planId: plan.id, txHash });
  assert.equal(result.status, 200);
  assert.equal(result.body.plan.state, 'SUBMITTED');
  assert.equal(recorded.txHash, txHash);
});

test('does not record a transaction that is not the designated release_payout call', async () => {
  const txHash = '11111111111111111111111111111111111111111111';
  const plan = {
    id: 'plan-test-1', state: 'AUTHORIZED', network: 'testnet', circleId: CIRCLE,
    contractId: CONTRACT, codeSha256: HASH, round: 1, recipient: MEMBERS[1],
    amountYocto: '3000000000000000000000000',
  };
  let recorded = false;
  const handler = createPayoutExecutionHandler({
    store: {
      findMembershipForPrincipal: () => ({ status: 'ACTIVE' }),
      getVerifiedContractBinding: () => ({ network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic' }),
      getCircleScheduleParityContext: () => ({ ready: true, local: {} }),
    },
    executionStore: {
      get: () => plan, prepare() {}, authorize() {},
      recordSubmitted() { recorded = true; return plan; },
    },
    authenticateRequest: async () => ({ subject: 'ajotest3.testnet' }),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { result: {
          transaction: {
            hash: txHash, signer_id: CONTRACT, receiver_id: CONTRACT,
            actions: [{ FunctionCall: { method_name: 'transfer', args: 'e30=', deposit: '0', gas: '300000000000000' } }],
          },
          status: { SuccessValue: '' }, transaction_outcome: { outcome: { status: { SuccessValue: '' } } },
          receipts_outcome: [],
        } };
      },
    }),
  });
  const result = await invoke(handler, { action: 'recordSubmitted', planId: plan.id, txHash });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'PAYOUT_SUBMISSION_NOT_VERIFIED');
  assert.equal(recorded, false);
});


test('finalize supplies persisted expected circle mode and records only verified payout completion', async () => {
  const txHash = '11111111111111111111111111111111111111111111';
  const plan = {
    id: 'plan-finalize-1', state: 'SUBMITTED', network: 'testnet', circleId: CIRCLE,
    contractId: CONTRACT, codeSha256: HASH, round: 1, recipient: MEMBERS[1],
    amountYocto: '3000000000000000000000000', txHash,
  };
  const local = { contractId: CONTRACT, mode: 'PROTECTED_PUBLIC' };
  const binding = { network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic' };
  let verifierArgs;
  let finalized = null;
  const views = {
    get_round: 1,
    is_payout_pending: false,
    is_payout_complete: true,
    is_circle_completed: false,
  };
  const handler = createPayoutExecutionHandler({
    store: {
      findMembershipForPrincipal: () => ({ status: 'ACTIVE' }),
      getVerifiedContractBinding: () => binding,
      getCircleScheduleParityContext: () => ({ ready: true, local }),
    },
    executionStore: {
      get: () => plan,
      prepare() { throw new Error('not expected'); },
      authorize() { throw new Error('not expected'); },
      recordFinalized(id, evidence) {
        finalized = { ...plan, id, state: 'FINALIZED', finalityEvidence: evidence };
        return finalized;
      },
    },
    authenticateRequest: async () => ({ subject: 'ajotest1.testnet' }),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'tx') {
        return { ok: true, async json() { return { result: {
          transaction: {
            hash: txHash, signer_id: CONTRACT, receiver_id: CONTRACT,
            actions: [{ FunctionCall: { method_name: 'release_payout', args: 'e30=', deposit: '0', gas: '300000000000000' } }],
          },
          status: { SuccessValue: '' },
          transaction_outcome: { outcome: { status: { SuccessValue: '' } } },
          receipts_outcome: [],
        } }; } };
      }
      const method = request.params.method_name;
      const bytes = Buffer.from(JSON.stringify(views[method]), 'utf8');
      return { ok: true, async json() { return { result: { result: [...bytes] } }; } };
    },
    verifyContract: async args => {
      verifierArgs = args;
      return { verified: true, network: 'testnet', contractId: CONTRACT, codeSha256: HASH };
    },
    clock: () => 123456789,
  });
  const result = await invoke(handler, { action: 'finalize', planId: plan.id });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'FINALIZED');
  assert.equal(result.body.plan.state, 'FINALIZED');
  assert.equal(verifierArgs.expectedMode, 'PROTECTED_PUBLIC');
  assert.equal(finalized.finalityEvidence.finalityVerified, true);
});

test('CLI submission blocks public rotating payout before any signer call', async () => {
  const plan = {
    id: 'plan-cli-confirmation', state: 'AUTHORIZED', network: 'testnet', circleId: CIRCLE,
    contractId: CONTRACT, codeSha256: HASH, round: 2, recipient: MEMBERS[2],
    amountYocto: '3000000000000000000000000',
  };
  let signerCalled = false;
  const handler = createPayoutExecutionHandler({
    store: {
      findMembershipForPrincipal: () => ({ status: 'ACTIVE' }),
      getVerifiedContractBinding: () => ({ network: 'testnet', contractId: CONTRACT, codeSha256: HASH, mode: 'ProtectedPublic' }),
      getCircleScheduleParityContext: () => ({ ready: true, local: { contractId: CONTRACT, mode: 'PROTECTED_PUBLIC' } }),
    },
    executionStore: {
      get: () => plan,
      prepare() { throw new Error('not expected'); },
      authorize() { throw new Error('not expected'); },
      recordUnknown() { throw new Error('not expected'); },
    },
    authenticateRequest: async () => ({ subject: MEMBERS[0] }),
    submitPayout: async () => { signerCalled = true; throw new Error('must not submit'); },
  });
  const result = await invoke(handler, {
    action: 'submitCli', planId: plan.id,
    confirmation: 'SUBMIT TESTNET PAYOUT wrong-contract ROUND 2',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'PUBLIC_PROPORTIONAL_DISTRIBUTION_REQUIRED');
  assert.equal(signerCalled, false);
});
