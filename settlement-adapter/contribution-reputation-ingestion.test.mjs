import test from 'node:test';
import assert from 'node:assert/strict';
import { MemberReputationStore } from './member-reputation-store.mjs';
import { createContributionReputationIngestion, createApplicationBackedContributionReputationIngestion } from './contribution-reputation-ingestion.mjs';
import { ApplicationStore } from './application-store.mjs';

const principal = Object.freeze({ subject: 'auth-subject-1' });
const context = overrides => ({
  circleId: 'circle-1', memberId: 'member-internal-1', round: 0,
  circleStatus: 'ACTIVE', memberStatus: 'ACTIVE', roundStatus: 'OPEN',
  contractId: 'circle.testnet', memberNearAccount: 'member.testnet',
  requiredContributionAmount: '1000000000000000000000000',
  roundDeadlineNs: '1800000000000000000', ...overrides,
});
function fixture({ ctx = context(), evidenceOverrides = {}, bindingOverrides = {}, membership = 'member-internal-1' } = {}) {
  const calls = { identity: [], context: [], verify: [], append: [] };
  const store = new MemberReputationStore({
    verifyEvidence: ({ evidenceRef }) => ({ verified: evidenceRef.startsWith('near:testnet:tx:'), digest: `store:${evidenceRef}` }),
    authorizeReviewer: () => false,
  });
  const ingestion = createContributionReputationIngestion({
    reputationStore: { appendVerifiedEvent: event => { calls.append.push(event); return store.appendVerifiedEvent(event); } },
    resolveMemberIdentity: async args => { calls.identity.push(args); return membership; },
    resolveTrustedContext: async args => { calls.context.push(args); return ctx; },
    verifyRoundBinding: async args => ({ verified: true, transactionHash: args.transactionHash, contractId: args.contractId, round: args.round, ...bindingOverrides }),
    verifyEvidence: async args => {
      calls.verify.push(args);
      return { verified: true, outcome: 'ON_TIME', evidenceRef: `near:testnet:tx:${args.transactionHash}`,
        digest: 'sha256:trusted-fixture', signerId: args.signerId, contractId: args.contractId,
        amountYocto: args.expectedAmountYocto, deadlineNs: args.expectedDeadlineNs, ...evidenceOverrides };
    },
  });
  return { store, ingestion, calls };
}

test('ingests only finalized verifier output using identity and obligation values from trusted resolvers', async () => {
  const { store, ingestion, calls } = fixture();
  try {
    const result = await ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx-hash-1' });
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, 'ON_TIME');
    assert.deepEqual(calls.identity[0], { principal, circleId: 'circle-1' });
    assert.deepEqual(calls.context[0], { circleId: 'circle-1', memberId: 'member-internal-1', round: 0 });
    assert.deepEqual(calls.verify[0], {
      transactionHash: 'tx-hash-1', signerId: 'member.testnet', contractId: 'circle.testnet',
      expectedAmountYocto: '1000000000000000000000000', expectedDeadlineNs: '1800000000000000000',
    });
    assert.equal(calls.append[0].memberId, 'member-internal-1');
    assert.equal(calls.append[0].payload.outcome, 'ON_TIME');
    assert.equal(store.getMemberProfile({ memberId: 'member-internal-1' }).onTimePayments, 1);
  } finally { store.close(); }
});

test('rejects absent principal, inactive membership, mismatched trusted context and inactive circle state', async () => {
  const noPrincipal = fixture();
  try { await assert.rejects(noPrincipal.ingestion.ingest({ circleId: 'circle-1', round: 0, transactionHash: 'tx' }), /authenticated principal/); }
  finally { noPrincipal.store.close(); }
  const noMember = fixture({ membership: null });
  try { await assert.rejects(noMember.ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx' }), /Active circle membership/); }
  finally { noMember.store.close(); }
  const mismatch = fixture({ ctx: context({ circleId: 'attacker-circle' }) });
  try { await assert.rejects(mismatch.ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx' }), /missing or mismatched/); }
  finally { mismatch.store.close(); }
  const closed = fixture({ ctx: context({ roundStatus: 'CLOSED' }) });
  try { await assert.rejects(closed.ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx' }), /must all be active/); assert.equal(closed.calls.verify.length, 0); }
  finally { closed.store.close(); }
});

test('rejects caller identity fields and verifier output that does not match trusted evidence', async () => {
  const wrongMember = fixture({ evidenceOverrides: { signerId: 'attacker.testnet' } });
  try { await assert.rejects(wrongMember.ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx', memberId: 'attacker' }), /did not match the trusted obligation/); assert.equal(wrongMember.calls.append.length, 0); }
  finally { wrongMember.store.close(); }
  const wrongRef = fixture({ evidenceOverrides: { evidenceRef: 'near:testnet:tx:other' } });
  try { await assert.rejects(wrongRef.ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx' }), /did not match the trusted obligation/); }
  finally { wrongRef.store.close(); }
  const late = fixture({ evidenceOverrides: { outcome: 'LATE' } });
  try { await assert.rejects(late.ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx' }), /did not match the trusted obligation/); }
  finally { late.store.close(); }
});

test('requires trusted historical round binding before recording evidence', async () => {
  const { store, ingestion, calls } = fixture({ bindingOverrides: { round: 1 } });
  try {
    await assert.rejects(ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx-hash-1' }), /Historical transaction-to-round binding/);
    assert.equal(calls.append.length, 0);
    assert.equal(store.getMemberProfile({ memberId: 'member-internal-1' }).onTimePayments, 0);
  } finally { store.close(); }
});

test('stable obligation key prevents a second scoreable event for the same round', async () => {
  const { store, ingestion } = fixture();
  try {
    await ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx-hash-1' });
    await assert.rejects(ingestion.ingest({ principal, circleId: 'circle-1', round: 0, transactionHash: 'tx-hash-2' }), /UNIQUE constraint/);
    assert.equal(store.getMemberProfile({ memberId: 'member-internal-1' }).onTimePayments, 1);
  } finally { store.close(); }
});

test('application-backed ingestion uses real SQLite membership and trusted round context', async () => {
  const applicationStore = new ApplicationStore();
  const reputationStore = new MemberReputationStore({ verifyEvidence: ({ evidenceRef }) => ({ verified: evidenceRef.startsWith('near:testnet:tx:'), digest: `store:${evidenceRef}` }), authorizeReviewer: () => false });
  applicationStore.upsertCircle({ circleId: 'real-circle', contractId: 'real-circle.testnet' });
  applicationStore.upsertMember({ memberId: 'real-member', principalId: 'auth-subject-1', nearAccount: 'alice.testnet' });
  applicationStore.setMembership({ circleId: 'real-circle', memberId: 'real-member', status: 'ACTIVE' });
  applicationStore.setRound({ circleId: 'real-circle', round: 0, status: 'OPEN', contributionAmount: '1000000000000000000000000', deadlineMs: 1900000000000 });
  const ingestion = createApplicationBackedContributionReputationIngestion({
    applicationStore, reputationStore, getPrincipalId: value => value.subject,
    verifyRoundBinding: async input => ({ verified: true, transactionHash: input.transactionHash, contractId: input.contractId, round: input.round }),
    verifyEvidence: async input => ({ verified: true, outcome: 'ON_TIME', evidenceRef: `near:testnet:tx:${input.transactionHash}`, digest: 'sha256:sqlite-integration', signerId: input.signerId, contractId: input.contractId, amountYocto: input.expectedAmountYocto, deadlineNs: input.expectedDeadlineNs }),
  });
  try {
    const result = await ingestion.ingest({ principal, circleId: 'real-circle', round: 0, transactionHash: 'sqlite-tx-1', memberId: 'spoofed-member' });
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, 'ON_TIME');
    assert.equal(reputationStore.getMemberProfile({ memberId: 'real-member' }).onTimePayments, 1);
    assert.equal(reputationStore.getMemberProfile({ memberId: 'spoofed-member' }).onTimePayments, 0);
  } finally { applicationStore.close(); reputationStore.close(); }
});

test('application-backed ingestion fails closed for unknown principals and closed rounds', async () => {
  const applicationStore = new ApplicationStore();
  const reputationStore = new MemberReputationStore({ verifyEvidence: () => ({ verified: true, digest: 'unused' }), authorizeReviewer: () => false });
  applicationStore.upsertCircle({ circleId: 'gate-circle', contractId: 'gate-circle.testnet' });
  applicationStore.upsertMember({ memberId: 'gate-member', principalId: 'known-user', nearAccount: 'known.testnet' });
  applicationStore.setMembership({ circleId: 'gate-circle', memberId: 'gate-member', status: 'ACTIVE' });
  applicationStore.setRound({ circleId: 'gate-circle', round: 0, status: 'CLOSED', contributionAmount: '100', deadlineMs: 1900000000000 });
  let verifyCalls = 0;
  const ingestion = createApplicationBackedContributionReputationIngestion({ applicationStore, reputationStore, getPrincipalId: value => value.subject, verifyRoundBinding: async input => ({ verified: true, transactionHash: input.transactionHash, contractId: input.contractId, round: input.round }), verifyEvidence: async () => { verifyCalls += 1; return {}; } });
  try {
    await assert.rejects(ingestion.ingest({ principal: { subject: 'unknown-user' }, circleId: 'gate-circle', round: 0, transactionHash: 'tx' }), /Active circle membership/);
    await assert.rejects(ingestion.ingest({ principal: { subject: 'known-user' }, circleId: 'gate-circle', round: 0, transactionHash: 'tx' }), /must all be active/);
    assert.equal(verifyCalls, 0);
    assert.equal(reputationStore.getMemberProfile({ memberId: 'gate-member' }).onTimePayments, 0);
  } finally { applicationStore.close(); reputationStore.close(); }
});


test('application-backed ingestion uses the real indexed round-binding adapter by default', async () => {
  const applicationStore = new ApplicationStore();
  const reputationStore = new MemberReputationStore({
    verifyEvidence: ({ evidenceRef }) => ({ verified: evidenceRef.startsWith('near:testnet:tx:'), digest: `store:${evidenceRef}` }),
    authorizeReviewer: () => false,
  });
  applicationStore.upsertCircle({ circleId: 'indexed-circle', contractId: 'indexed-circle.testnet' });
  applicationStore.upsertMember({ memberId: 'indexed-member', principalId: 'auth-subject-1', nearAccount: 'alice.testnet' });
  applicationStore.setMembership({ circleId: 'indexed-circle', memberId: 'indexed-member', status: 'ACTIVE' });
  applicationStore.setRound({ circleId: 'indexed-circle', round: 0, status: 'OPEN', contributionAmount: '1000000000000000000000000', deadlineMs: 1900000000000 });
  const transactionHash = '4WDSWBFwoukZrRBDfuZffBfZrgrajGoBrfBwuMHHsMBE';
  const blockHash = '2atms6gpLFZPn4ojnQ1NXxfAj6sAWh4uQ6ky8x6rjjTe';
  const receiptId = '3X8oZsfbZ2RsMXN4GCTsPmgfnVnC7PEiTV1WZwSBCTXb';
  const eventLog = 'EVENT_JSON:' + JSON.stringify({
    standard: 'ajocircle', version: '1.0.0', event: 'contribution_recorded',
    data: [{ member_id: 'alice.testnet', round: 0, amount_yocto: '1000000000000000000000000' }],
  });
  let indexedRequest;
  const fetchImpl = async (url, init) => {
    indexedRequest = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({ transactions: [{
        transaction: {
          hash: transactionHash, signer_id: 'alice.testnet', receiver_id: 'indexed-circle.testnet',
          actions: [{ FunctionCall: { method_name: 'contribute', deposit: '1000000000000000000000000' } }],
        },
        execution_outcome: { block_hash: blockHash },
        receipts: [{
          receipt: { receipt_id: receiptId, receiver_id: 'indexed-circle.testnet' },
          execution_outcome: { outcome: { logs: [eventLog] } },
        }],
      }] }),
    };
  };
  const ingestion = createApplicationBackedContributionReputationIngestion({
    applicationStore, reputationStore, getPrincipalId: value => value.subject, fetchImpl,
    verifyEvidence: async input => ({
      verified: true, outcome: 'ON_TIME', evidenceRef: `near:testnet:tx:${input.transactionHash}`,
      digest: 'sha256:verified-base-evidence', signerId: input.signerId, contractId: input.contractId,
      amountYocto: input.expectedAmountYocto, deadlineNs: input.expectedDeadlineNs,
      transactionHash, blockHash,
    }),
  });
  try {
    const result = await ingestion.ingest({ principal, circleId: 'indexed-circle', round: 0, transactionHash });
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, 'ON_TIME');
    assert.equal(indexedRequest.url, 'https://tx.test.fastnear.com/v0/transactions');
    assert.deepEqual(indexedRequest.body, { tx_hashes: [transactionHash] });
    assert.equal(reputationStore.getMemberProfile({ memberId: 'indexed-member' }).onTimePayments, 1);
  } finally { applicationStore.close(); reputationStore.close(); }
});
