import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { APPROVED_AJOCIRCLE_TESTNET_SHA256, verifyAjoCircleContract } from './near-contract-verification.mjs';

function response(value) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'ajocircle-contract-verify', result: value }) };
}
function viewResponse(value) {
  return { result: [...Buffer.from(JSON.stringify(value), 'utf8')] };
}
function verifierFetch({ mode = 'ProtectedPublic', hash = APPROVED_AJOCIRCLE_TESTNET_SHA256, calls = [], overrides = {} } = {}) {
  const wasm = Buffer.from('approved test wasm bytes');
  const expected = createHash('sha256').update(wasm).digest('hex');
  const values = {
    get_mode: mode, get_round: 0, get_round_deadline: '1800000000000000000', get_round_deadlines: ['1800000000000000000', '1800000900000000000'],
    get_contribution_count: 0, get_current_recipient: 'member.testnet',
    is_circle_completed: false, is_payout_pending: false, is_payout_complete: false,
    get_required_protection: '3000000000000000000000000',
    get_members: ['member.testnet', 'second.testnet'], get_member_count: 2,
    get_contribution_amount: '1000000000000000000000000',
    get_payout_order: ['member.testnet', 'second.testnet'], get_treasurer_agent: 'treasurer.testnet',
  };
  Object.assign(values, overrides);
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request.params);
    if (request.params.request_type === 'view_code') {
      const code = hash === APPROVED_AJOCIRCLE_TESTNET_SHA256 ? wasm : Buffer.from('unapproved code');
      return response({ code_base64: code.toString('base64') });
    }
    const name = request.params.method_name;
    return response(viewResponse(values[name]));
  };
  return { fetchImpl, expected };
}

test('verifies approved deployed code and reads expected lifecycle views without transactions', async () => {
  const calls = [];
  const { fetchImpl } = verifierFetch({ calls });
  const approved = createHash('sha256').update(Buffer.from('approved test wasm bytes')).digest('hex');
  const result = await verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl, expectedSha256: approved });
  assert.equal(result.verified, true);
  assert.equal(result.codeSha256, approved);
  assert.equal(result.mode, 'ProtectedPublic');
  assert.equal(result.currentRecipient, 'member.testnet');
  assert.deepEqual(result.members, ['member.testnet', 'second.testnet']);
  assert.equal(result.memberCount, 2);
  assert.equal(result.contributionAmount, '1000000000000000000000000');
  assert.deepEqual(result.payoutOrder, ['member.testnet', 'second.testnet']);
  assert.equal(result.treasurerAgent, 'treasurer.testnet');
  assert.equal(result.quoteReady, false);
  assert.deepEqual(result.rounds, [
    { round: 0, contributionAmount: '1000000000000000000000000', deadlineNs: '1800000000000000000' },
    { round: 1, contributionAmount: '1000000000000000000000000', deadlineNs: '1800000900000000000' },
  ]);
  assert.match(result.quoteReadinessReason, /Complete on-chain schedule is available/);
  assert.match(result.quoteReadinessReason, /quote creation remains blocked/i);
  assert.equal(calls.length, 16);
  assert.equal(calls[0].request_type, 'view_code');
  assert.ok(calls.every(call => call.finality === 'final'));
  assert.ok(calls.every(call => call.request_type === 'view_code' || call.method_name));
});

test('rejects unapproved code before reading contract methods', async () => {
  const calls = [];
  const { fetchImpl } = verifierFetch({ calls });
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl }), /not on the approved allowlist/);
  assert.equal(calls.length, 1);
});

test('rejects a deployed contract whose mode does not match the local policy', async () => {
  const { fetchImpl } = verifierFetch({ mode: 'Private' });
  const approved = createHash('sha256').update(Buffer.from('approved test wasm bytes')).digest('hex');
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl, expectedSha256: approved }), /mode does not match/);
});

test('rejects inconsistent member counts and payout orders from contract views', async () => {
  const { fetchImpl: badCount } = verifierFetch({ overrides: { get_member_count: 3 } });
  const approved = createHash('sha256').update(Buffer.from('approved test wasm bytes')).digest('hex');
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl: badCount, expectedSha256: approved }), /member count does not match/);

  const { fetchImpl: badOrder } = verifierFetch({ overrides: { get_payout_order: ['member.testnet', 'member.testnet'] } });
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl: badOrder, expectedSha256: approved }), /invalid payout order/);
});

test('rejects malformed, non-increasing, or current-deadline-mismatched schedules', async () => {
  const approved = createHash('sha256').update(Buffer.from('approved test wasm bytes')).digest('hex');
  const { fetchImpl: malformed } = verifierFetch({ overrides: { get_round_deadlines: ['1800000000000000000', 'not-a-deadline'] } });
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl: malformed, expectedSha256: approved }), /invalid full round schedule/);

  const { fetchImpl: unordered } = verifierFetch({ overrides: { get_round_deadlines: ['1800000000000000000', '1700000000000000000'] } });
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl: unordered, expectedSha256: approved }), /non-increasing round schedule/);

  const { fetchImpl: mismatched } = verifierFetch({ overrides: { get_round_deadline: '1800000000000000001' } });
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl: mismatched, expectedSha256: approved }), /does not match the full schedule/);
});

test('only permits NEAR testnet and validates account IDs', async () => {
  const { fetchImpl } = verifierFetch();
  await assert.rejects(verifyAjoCircleContract({ contractId: 'bad id', expectedMode: 'PROTECTED_PUBLIC', fetchImpl }), /Invalid NEAR/);
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', rpcUrl: 'https://rpc.mainnet.near.org', fetchImpl }), /only permits/);
});


test('retries a transient RPC transport failure once and then verifies finalized read-only state', async () => {
  const calls = [];
  const { fetchImpl: stableFetch, expected } = verifierFetch({ calls });
  let attempts = 0;
  const fetchImpl = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return stableFetch(...args);
  };
  const result = await verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', fetchImpl, expectedSha256: expected, timeoutMs: 100 });
  assert.equal(result.verified, true);
  assert.equal(attempts, 17);
  assert.equal(calls.length, 16);
});

test('fails closed after the bounded retry when the RPC transport remains unavailable', async () => {
  let attempts = 0;
  await assert.rejects(verifyAjoCircleContract({ contractId: 'circle.testnet', expectedMode: 'PROTECTED_PUBLIC', timeoutMs: 100, fetchImpl: async () => { attempts += 1; throw new TypeError('fetch failed'); } }), /NEAR RPC transport failed after retry/);
  assert.equal(attempts, 2);
});
