import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationStore } from './application-store.mjs';
import { ContributionEvidenceStore } from './contribution-evidence-store.mjs';
import { MemberReputationStore } from './member-reputation-store.mjs';
import { createApplicationBackedContributionReputationIngestion } from './contribution-reputation-ingestion.mjs';
import { createContributionReputationHandler } from './contribution-reputation-handler.mjs';
import { createAjoApiHandler } from './ajo-api-handler.mjs';

const PRINCIPAL = 'authenticated-wallet.testnet';
const TX = '4WDSWBFwoukZrRBDfuZffBfZrgrajGoBrfBwuMHHsMBE';
const BLOCK = '2atms6gpLFZPn4ojnQ1NXxfAj6sAWh4uQ6ky8x6rjjTe';

test('HTTP evidence endpoint persists verified evidence and safely retries after a reputation write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ajo-reputation-http-'));
  const applicationStore = new ApplicationStore({ path: join(directory, 'application.sqlite') });
  const evidenceStore = new ContributionEvidenceStore({ path: join(directory, 'evidence.sqlite') });
  const reputationDb = join(directory, 'reputation.sqlite');
  const reputationStore = new MemberReputationStore({
    path: reputationDb,
    verifyEvidence: event => evidenceStore.verifyReference(event),
    authorizeReviewer: () => false,
  });

  applicationStore.upsertCircle({ circleId: 'http-circle', contractId: 'http-circle.testnet' });
  applicationStore.upsertMember({
    memberId: 'http-member', principalId: PRINCIPAL, nearAccount: 'alice.testnet',
  });
  applicationStore.setMembership({ circleId: 'http-circle', memberId: 'http-member', status: 'ACTIVE' });
  applicationStore.setRound({
    circleId: 'http-circle', round: 0, status: 'OPEN',
    contributionAmount: '1000000000000000000000000',
    deadlineMs: Date.now() + 60 * 60_000,
  });

  const mockWasm = Buffer.from('approved testnet contract fixture wasm');
  const approvedCodeHash = createHash('sha256').update(mockWasm).digest('hex');
  const amountYocto = '1000000000000000000000000';
  const receiptId = '3X8oZsfbZ2RsMXN4GCTsPmgfnVnC7PEiTV1WZwSBCTXb';
  const eventLog = 'EVENT_JSON:' + JSON.stringify({
    standard: 'ajocircle', version: '1.0.0', event: 'contribution_recorded',
    data: [{ member_id: 'alice.testnet', round: 0, amount_yocto: amountYocto }],
  });
  const chainCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const request = options.body ? JSON.parse(options.body) : {};
    chainCalls.push({ url: target, request });
    if (target === 'https://rpc.testnet.fastnear.com') {
      if (request.method === 'query' && request.params?.request_type === 'view_code') {
        return { ok: true, json: async () => ({ result: { code_base64: mockWasm.toString('base64') } }) };
      }
      if (request.method === 'tx') {
        return { ok: true, json: async () => ({ result: {
          final_execution_status: 'FINAL',
          transaction: {
            hash: TX, signer_id: 'alice.testnet', receiver_id: 'http-circle.testnet',
            actions: [{ FunctionCall: { method_name: 'contribute', args: 'e30=', deposit: amountYocto } }],
          },
          status: { SuccessValue: '' },
          transaction_outcome: { block_hash: BLOCK },
        } }) };
      }
      if (request.method === 'block') {
        return { ok: true, json: async () => ({ result: {
          header: { hash: BLOCK, timestamp_nanosec: '1700000000000000000' },
        } }) };
      }
      throw new Error('Unexpected mocked NEAR RPC request');
    }
    if (target === 'https://tx.test.fastnear.com/v0/transactions') {
      return { ok: true, json: async () => ({ transactions: [{
        transaction: {
          hash: TX, signer_id: 'alice.testnet', receiver_id: 'http-circle.testnet',
          actions: [{ FunctionCall: { method_name: 'contribute', args: 'e30=', deposit: amountYocto } }],
        },
        execution_outcome: { block_hash: BLOCK },
        receipts: [{
          receipt: { receipt_id: receiptId, receiver_id: 'http-circle.testnet' },
          execution_outcome: { outcome: { logs: [eventLog] } },
        }],
      }] }) };
    }
    throw new Error(`Unexpected mocked chain URL: ${target}`);
  };

  let failFirstReputationWrite = true;
  const retryableReputationStore = {
    appendVerifiedEvent(event) {
      if (failFirstReputationWrite) {
        failFirstReputationWrite = false;
        throw new Error('temporary reputation database write failure');
      }
      return reputationStore.appendVerifiedEvent(event);
    },
  };

  const ingestion = createApplicationBackedContributionReputationIngestion({
    applicationStore,
    reputationStore: retryableReputationStore,
    evidenceStore,
    getPrincipalId: principal => principal.subject,
    verifyEvidence: args => import('./near-contribution-evidence.mjs').then(({ verifyNearContributionEvidence }) =>
      verifyNearContributionEvidence({ ...args, fetchImpl, approvedCodeHashes: [approvedCodeHash] })),
    fetchImpl,
  });
  const authenticateRequest = async request =>
    request.headers.authorization === 'Bearer test-session'
      ? Object.freeze({ subject: PRINCIPAL })
      : null;
  const reputationHandler = createContributionReputationHandler({ authenticateRequest, ingestion });
  const apiHandler = createAjoApiHandler({
    authHandler: async (_request, response) => { response.statusCode = 404; response.end(); },
    memberQuoteHandler: async (_request, response) => { response.statusCode = 404; response.end(); },
    contributionReputationHandler: reputationHandler,
  });
  const server = createServer(apiHandler);

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/api/member/contribution-evidence`;
    const request = () => fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-session', 'content-type': 'application/json' },
      body: JSON.stringify({ circleId: 'http-circle', round: 0, transactionHash: TX }),
    });

    const failed = await request();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'INGESTION_UNAVAILABLE' });

    // Evidence must be durable even though the downstream reputation write failed.
    const saved = evidenceStore.verifyReference({
      evidenceRef: `near:testnet:tx:${TX}`, memberId: 'http-member',
      circleId: 'http-circle', eventKind: 'OBLIGATION',
      payload: { obligationId: 'http-circle:0:http-member', outcome: 'ON_TIME' },
    });
    assert.equal(saved.verified, true);
    assert.equal(reputationStore.getMemberProfile({ memberId: 'http-member' }).onTimePayments, 0);

    const retried = await request();
    assert.equal(retried.status, 200);
    const result = await retried.json();
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, 'ON_TIME');
    assert.equal(result.circleId, 'http-circle');
    assert.equal(result.round, 0);
    assert.equal(reputationStore.getMemberProfile({ memberId: 'http-member' }).onTimePayments, 1);

    // Retry repeats validation, but never duplicates the evidence row or scoreable event.
    assert.equal(chainCalls.filter(call => call.url === 'https://rpc.testnet.fastnear.com').length, 6);
    assert.equal(chainCalls.filter(call => call.url === 'https://tx.test.fastnear.com/v0/transactions').length, 2);
    assert.equal(evidenceStore.db.prepare('SELECT COUNT(*) AS count FROM verified_contribution_evidence').get().count, 1);
    assert.equal(reputationStore.db.prepare('SELECT COUNT(*) AS count FROM reputation_events').get().count, 1);

    const duplicate = await request();
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'EVIDENCE_ALREADY_RECORDED' });
    assert.equal(reputationStore.getMemberProfile({ memberId: 'http-member' }).onTimePayments, 1);
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
    applicationStore.close();
    reputationStore.close();
    evidenceStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP evidence endpoint rejects unauthenticated requests and caller-supplied identity fields', async () => {
  const authenticateRequest = async request =>
    request.headers.authorization === 'Bearer test-session'
      ? Object.freeze({ subject: PRINCIPAL })
      : null;
  const ingestion = { ingest: async () => { throw new Error('should not be called'); } };
  const handler = createContributionReputationHandler({ authenticateRequest, ingestion });
  const server = createServer(handler);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/api/member/contribution-evidence`;
    const unauthenticated = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ circleId: 'http-circle', round: 0, transactionHash: TX }),
    });
    assert.equal(unauthenticated.status, 401);

    const spoofed = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-session', 'content-type': 'application/json' },
      body: JSON.stringify({
        circleId: 'http-circle', round: 0, transactionHash: TX, memberId: 'attacker',
      }),
    });
    assert.equal(spoofed.status, 400);
    assert.deepEqual(await spoofed.json(), { error: 'INVALID_BODY' });
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
});
