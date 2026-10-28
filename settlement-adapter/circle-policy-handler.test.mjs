import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationStore } from './application-store.mjs';
import {
  CIRCLE_CREATE_PATH,
  CIRCLE_CONTRACT_VERIFY_PATH,
  CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH,
  CIRCLE_INVITATION_PATH,
  CIRCLE_JOIN_PATH,
  CIRCLE_POLICY_PREVIEW_PATH,
  CIRCLE_CYCLE_STATUS_PATH,
  CIRCLE_CYCLE_CONFIGURE_PATH,
  CIRCLE_CYCLE_IMPORT_PATH,
  CIRCLE_CYCLE_START_PATH,
  createCirclePolicyHandler,
} from './circle-policy-handler.mjs';

function responseDouble() {
  return {
    headers: {}, statusCode: 200, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body; this.writableEnded = true; },
    json() { return JSON.parse(this.body); },
  };
}
function request(path, body, subject = 'alice.near', method = 'POST') {
  return { url: path, method, headers: { authorization: 'Bearer verified-test-token' }, body, subject };
}
function setup() {
  let now = 1000;
  const store = new ApplicationStore({ clock: () => new Date(now).toISOString() });
  store.upsertCircle({ circleId: 'public-circle', contractId: 'public.testnet' });
  store.upsertCircle({ circleId: 'private-circle', contractId: 'private.testnet' });
  store.createCirclePolicy({ circleId: 'public-circle', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  store.createCirclePolicy({ circleId: 'private-circle', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 });
  store.upsertMember({ memberId: 'creator', principalId: 'creator.near', nearAccount: 'creator.near' });
  store.setMembership({ circleId: 'private-circle', memberId: 'creator', status: 'ACTIVE' });
  const handler = createCirclePolicyHandler({
    store,
    authenticateRequest: async req => req.subject ? { subject: req.subject } : null,
    clock: () => now,
  });
  return { store, handler, setNow(value) { now = value; } };
}

async function call(handler, req) {
  const res = responseDouble();
  await handler(req, res);
  return res;
}

test('public policy preview requires authentication and returns the current version without mutation', async () => {
  const { store, handler } = setup();
  const unauthorized = await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: 'public-circle' }, null));
  assert.equal(unauthorized.statusCode, 401);
  const preview = await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: 'public-circle' }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().policy.mode, 'PROTECTED_PUBLIC');
  assert.equal(preview.json().policy.penaltyBps, 500);
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.equal(store.getCirclePolicy({ circleId: 'public-circle' }).policyVersion, 1);
  store.close();
});

test('private policy preview hides the circle without a valid invitation token', async () => {
  const { store, handler } = setup();
  const invite = store.createCircleInvitation({ circleId: 'private-circle', createdByMemberId: 'creator', expiresAtMs: 5000, maxUses: 1, nowMs: 1000 });
  assert.equal((await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: 'private-circle' }))).statusCode, 404);
  assert.equal((await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: 'private-circle', inviteToken: 'wrong' }))).statusCode, 404);
  const preview = await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: 'private-circle', inviteToken: invite.token }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().policy.invitationOnly, true);
  store.close();
});

test('public join requires explicit current-policy acceptance and rejects stale versions', async () => {
  const { store, handler } = setup();
  assert.equal((await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'public-circle', policyVersion: 1, accepted: false }))).statusCode, 400);
  assert.equal((await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'public-circle', policyVersion: 2, accepted: true }))).statusCode, 409);
  const joined = await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'public-circle', policyVersion: 1, accepted: true }));
  assert.equal(joined.statusCode, 201);
  assert.equal(joined.json().membership.status, 'ACTIVE');
  assert.equal(store.hasAcceptedCirclePolicy({ circleId: 'public-circle', policyVersion: 1, memberId: joined.json().membership.memberId }), true);
  assert.equal((await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'public-circle', policyVersion: 1, accepted: true, inviteToken: 'extra' }))).statusCode, 400);
  store.close();
});

test('private invitation route creates token once, then join consumes it exactly once', async () => {
  const { store, handler } = setup();
  const created = await call(handler, request(CIRCLE_INVITATION_PATH, { circleId: 'private-circle', expiresInHours: 1, maxUses: 1 }, 'creator.near'));
  assert.equal(created.statusCode, 201);
  const token = created.json().invitation.token;
  assert.equal(typeof token, 'string');
  assert.equal((await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: 'private-circle', inviteToken: token }, 'invitee.near'))).statusCode, 200);
  const joined = await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'private-circle', policyVersion: 1, accepted: true, inviteToken: token }, 'invitee.near'));
  assert.equal(joined.statusCode, 201);
  const replay = await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'private-circle', policyVersion: 1, accepted: true, inviteToken: token }, 'other.near'));
  assert.equal(replay.statusCode, 403);
  assert.equal(replay.json().error, 'INVITATION_INVALID');
  assert.equal(store.findMembershipForPrincipal({ principalId: 'other.near', circleId: 'private-circle' }), null);
  store.close();
});

test('rejects unsupported fields, wrong methods, malformed JSON and invalid invite expiry', async () => {
  const { store, handler } = setup();
  assert.equal((await call(handler, request(CIRCLE_JOIN_PATH, { circleId: 'public-circle', policyVersion: 1, accepted: true, memberId: 'forged' }))).statusCode, 400);
  assert.equal((await call(handler, request(CIRCLE_JOIN_PATH, {}, 'alice.near', 'GET'))).statusCode, 405);
  const invalidJson = await call(handler, { url: CIRCLE_POLICY_PREVIEW_PATH, method: 'POST', headers: { authorization: 'Bearer token' }, subject: 'alice.near', async *[Symbol.asyncIterator]() { yield '{'; } });
  assert.equal(invalidJson.statusCode, 400);
  const invalidExpiry = await call(handler, request(CIRCLE_INVITATION_PATH, { circleId: 'private-circle', expiresInHours: 721 }, 'creator.near'));
  assert.equal(invalidExpiry.statusCode, 400);
  store.close();
});

test('private invitation creator can revoke a link and unrelated members cannot', async () => {
  const { store, handler } = setup();
  const created = await call(handler, request(CIRCLE_INVITATION_PATH, { circleId: 'private-circle', expiresInHours: 1 }, 'creator.near'));
  const token = created.json().invitation.token;
  const unauthorized = await call(handler, request('/api/circle/invitations/revoke', { circleId: 'private-circle', token }, 'other.near'));
  assert.equal(unauthorized.statusCode, 403);
  const revoked = await call(handler, request('/api/circle/invitations/revoke', { circleId: 'private-circle', token }, 'creator.near'));
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(revoked.json(), { revoked: true });
  assert.equal(store.getCircleInvitationContext({ circleId: 'private-circle', token, nowMs: 1000 }), null);
  store.close();
});

test('cycle status is membership-gated and only the creator can start a fully accepted cycle', async () => {
  const store = new ApplicationStore({ clock: () => new Date(1000).toISOString() });
  store.upsertCircle({ circleId: 'cycle-api', contractId: 'cycle-api.testnet' });
  store.upsertMember({ memberId: 'cycle-api-owner', principalId: 'cycle-api-owner.near', nearAccount: 'cycle-api-owner.near' });
  store.upsertMember({ memberId: 'cycle-api-member', principalId: 'cycle-api-member.near', nearAccount: 'cycle-api-member.near' });
  store.createCirclePolicy({ circleId: 'cycle-api', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  store.setMembership({ circleId: 'cycle-api', memberId: 'cycle-api-owner' });
  store.setMembership({ circleId: 'cycle-api', memberId: 'cycle-api-member' });
  store.recordCirclePolicyAcceptance({ circleId: 'cycle-api', policyVersion: 1, memberId: 'cycle-api-owner', accepted: true });
  store.recordCirclePolicyAcceptance({ circleId: 'cycle-api', policyVersion: 1, memberId: 'cycle-api-member', accepted: true });
  store.provisionCircleCycle({ circleId: 'cycle-api', createdByMemberId: 'cycle-api-owner', plannedRounds: 2 });
  store.setRound({ circleId: 'cycle-api', round: 0, contributionAmount: '100', deadlineMs: 2000 });
  store.setRound({ circleId: 'cycle-api', round: 1, contributionAmount: '100', deadlineMs: 3000 });
  const handler = createCirclePolicyHandler({ store, authenticateRequest: async req => req.subject ? { subject: req.subject } : null, clock: () => 1000 });
  assert.equal((await call(handler, request(CIRCLE_CYCLE_STATUS_PATH, { circleId: 'cycle-api' }, 'outsider.near'))).statusCode, 403);
  const status = await call(handler, request(CIRCLE_CYCLE_STATUS_PATH, { circleId: 'cycle-api' }, 'cycle-api-member.near'));
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().cycle.ready, true);
  const wrongStarter = await call(handler, request(CIRCLE_CYCLE_START_PATH, { circleId: 'cycle-api' }, 'cycle-api-member.near'));
  assert.equal(wrongStarter.statusCode, 403);
  const started = await call(handler, request(CIRCLE_CYCLE_START_PATH, { circleId: 'cycle-api' }, 'cycle-api-owner.near'));
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().cycle.status, 'STARTED');
  store.close();
});

test('authenticated circle creation requires a syntactically valid deployed contract ID and does not auto-accept policy', async () => {
  const store = new ApplicationStore();
  const handler = createCirclePolicyHandler({ store, authenticateRequest: async req => req.subject ? { subject: req.subject } : null, clock: () => 1000 });
  assert.equal((await call(handler, request(CIRCLE_CREATE_PATH, { contractId: 'bad id', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 }, 'creator.near'))).statusCode, 400);
  const created = await call(handler, request(CIRCLE_CREATE_PATH, { contractId: 'created-circle.testnet', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 }, 'creator.near'));
  assert.equal(created.statusCode, 201);
  const circle = created.json().circle;
  assert.equal(circle.policy.mode, 'PRIVATE_TRUSTED');
  assert.equal(circle.contractBindingVerified, false);
  assert.equal(circle.policyAcceptanceRequired, true);
  assert.equal(store.hasAcceptedCirclePolicy({ circleId: circle.circleId, policyVersion: 1, memberId: circle.creatorMemberId }), false);
  const preview = await call(handler, request(CIRCLE_POLICY_PREVIEW_PATH, { circleId: circle.circleId }, 'creator.near'));
  assert.equal(preview.statusCode, 200);
  const accepted = await call(handler, request(CIRCLE_JOIN_PATH, { circleId: circle.circleId, policyVersion: 1, accepted: true }, 'creator.near'));
  assert.equal(accepted.statusCode, 201);
  assert.equal(store.hasAcceptedCirclePolicy({ circleId: circle.circleId, policyVersion: 1, memberId: circle.creatorMemberId }), true);
  const duplicate = await call(handler, request(CIRCLE_CREATE_PATH, { contractId: 'created-circle.testnet', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 }, 'other.near'));
  assert.equal(duplicate.statusCode, 409);
  store.close();
});

test('contract verification is authenticated, available to active members, and records approved read-only evidence', async () => {
  const store = new ApplicationStore();
  const verificationCalls = [];
  const verification = {
    verified: true, network: 'testnet', codeSha256: '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0',
    currentRound: 0, roundDeadline: '1800000000000000000', contributionCount: 0, currentRecipient: 'recipient.testnet',
    circleCompleted: false, payoutPending: false, payoutComplete: false, requiredProtection: '0',
    verifiedAt: '2026-10-21T10:00:00.000Z', quoteReady: false,
    quoteReadinessReason: 'Local schedule cannot yet be proven to match contract configuration.',
  };
  let verificationTime = verification.verifiedAt;
  const handler = createCirclePolicyHandler({
    store,
    authenticateRequest: async req => req.subject ? { subject: req.subject } : null,
    verifyContract: async args => {
      verificationCalls.push(args);
      return { ...verification, verifiedAt: verificationTime, contractId: args.contractId,
        mode: args.expectedMode === 'PROTECTED_PUBLIC' ? 'ProtectedPublic' : 'Private' };
    },
  });
  const created = await call(handler, request(CIRCLE_CREATE_PATH, { contractId: 'verify-api.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 }, 'owner.near'));
  assert.equal(created.statusCode, 201);
  const circleId = created.json().circle.circleId;
  assert.ok(store.findMembershipForPrincipal({ principalId: 'owner.near', circleId }));
  const other = store.ensureMemberForPrincipal({ principalId: 'other.near', nearAccount: 'other.near' });
  store.setMembership({ circleId, memberId: other.memberId, status: 'ACTIVE' });
  const unauthenticated = await call(handler, request(CIRCLE_CONTRACT_VERIFY_PATH, { circleId }, null));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(verificationCalls.length, 0);
  const verifiedByMember = await call(handler, request(CIRCLE_CONTRACT_VERIFY_PATH, { circleId }, 'other.near'));
  assert.equal(verifiedByMember.statusCode, 200);
  assert.equal(verifiedByMember.json().binding.contractId, 'verify-api.testnet');
  assert.equal(verificationCalls.length, 1);
  const outsider = await call(handler, request(CIRCLE_CONTRACT_VERIFY_PATH, { circleId }, 'outsider.near'));
  assert.equal(outsider.statusCode, 403);
  assert.equal(verificationCalls.length, 1);
  const verified = await call(handler, request(CIRCLE_CONTRACT_VERIFY_PATH, { circleId }, 'owner.near'));
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().binding.contractId, 'verify-api.testnet');
  assert.equal(verified.json().binding.codeSha256, verification.codeSha256);
  assert.equal(verified.json().quoteReady, false);
  assert.equal(verificationCalls.length, 2);
  assert.equal(verificationCalls[1].expectedMode, 'PROTECTED_PUBLIC');
  assert.equal(store.getVerifiedContractBinding({ circleId }).quoteReady, false);

  // An authenticated creator can explicitly refresh stale evidence. The quote
  // readiness decision remains fail-closed when schedule parity is incomplete.
  verificationTime = new Date().toISOString();
  const refreshed = await call(handler, request(CIRCLE_CONTRACT_VERIFY_PATH, { circleId }, 'owner.near'));
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().binding.verifiedAt, verificationTime);
  assert.equal(verificationCalls.length, 3);
  assert.equal(refreshed.json().quoteReady, false);
  assert.equal(store.getVerifiedContractBinding({ circleId }).quoteReady, false);
  store.close();
});

test('schedule parity configuration route is creator-only and validates membership and payout order', async () => {
  const store = new ApplicationStore();
  const handler = createCirclePolicyHandler({ store, authenticateRequest: async req => req.subject ? { subject: req.subject } : null, clock: () => 1000 });
  const created = await call(handler, request(CIRCLE_CREATE_PATH, {
    contractId: 'parity-route.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  }, 'parity-owner.near'));
  const circleId = created.json().circle.circleId;
  const ownerId = created.json().circle.creatorMemberId;
  const member = store.ensureMemberForPrincipal({ principalId: 'parity-joiner.near', nearAccount: 'parity-joiner.near' });
  store.setMembership({ circleId, memberId: member.memberId, status: 'ACTIVE' });
  const payload = { circleId, members: ['parity-owner.near', 'parity-joiner.near'],
    payoutOrder: ['parity-owner.near', 'parity-joiner.near'], treasurerAgent: 'parity-route.testnet' };
  assert.equal((await call(handler, request(CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, payload, 'parity-joiner.near'))).statusCode, 403);
  assert.equal((await call(handler, request(CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, { ...payload, members: ['fake.near', 'other.near'] }, 'parity-owner.near'))).statusCode, 422);
  const configured = await call(handler, request(CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, payload, 'parity-owner.near'));
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.json().quoteReady, false);
  assert.deepEqual(configured.json().schedule.members, payload.members);
  store.close();
});

test('verified cycle import reconciles existing round lifecycle without enabling quotes for expired deadlines', async () => {
  const nowMs = Date.parse('2026-10-23T22:10:06.699Z');
  const store = new ApplicationStore({ clock: () => new Date(nowMs).toISOString() });
  const members = ['import1.testnet', 'import2.testnet', 'import3.testnet'];
  const rounds = [
    { round: 0, contributionAmount: '1000000000000000000000000', deadlineNs: '1792782860310766325' },
    { round: 1, contributionAmount: '1000000000000000000000000', deadlineNs: '1792787486459000000' },
    { round: 2, contributionAmount: '1000000000000000000000000', deadlineNs: '1792792988794398962' },
  ];
  const verification = {
    verified: true, network: 'testnet', contractId: 'import-cycle.testnet',
    codeSha256: 'b1edaeea67c59477155330de826c219e9731361de61a4faf29b28382365b3cf6',
    mode: 'ProtectedPublic', currentRound: 2, roundDeadline: rounds[2].deadlineNs, contributionCount: 1,
    currentRecipient: members[2], circleCompleted: false, payoutPending: false, payoutComplete: false,
    requiredProtection: '0', verifiedAt: new Date(nowMs).toISOString(),
    members, memberCount: 3, contributionAmount: rounds[0].contributionAmount, payoutOrder: members,
    treasurerAgent: 'import-cycle.testnet', rounds, roundDeadlines: rounds.map(round => round.deadlineNs),
    quoteReady: false, quoteReadinessReason: 'Read-only verification.',
  };
  let verifyCalls = 0;
  const handler = createCirclePolicyHandler({
    store,
    authenticateRequest: async req => req.subject ? { subject: req.subject } : null,
    clock: () => nowMs,
    verifyContract: async () => { verifyCalls += 1; return verification; },
  });
  const created = await call(handler, request(CIRCLE_CREATE_PATH, {
    contractId: 'import-cycle.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  }, 'import-owner.near'));
  const circleId = created.json().circle.circleId;
  const ownerId = created.json().circle.creatorMemberId;
  for (const account of members) {
    const member = store.ensureMemberForPrincipal({ principalId: account, nearAccount: account });
    store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: member.memberId, accepted: true });
    store.joinCircleAfterPolicyAcceptance({ circleId, memberId: member.memberId });
  }
  const schedule = await call(handler, request(CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, {
    circleId, members, payoutOrder: members, treasurerAgent: 'import-cycle.testnet',
  }, 'import-owner.near'));
  assert.equal(schedule.statusCode, 200);
  const imported = await call(handler, request(CIRCLE_CYCLE_IMPORT_PATH, { circleId }, 'import-owner.near'));
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().imported, true);
  assert.equal(imported.json().cycle.status, 'STARTED');
  assert.equal(imported.json().binding.currentRound, 2);
  assert.equal(imported.json().quoteReady, false);
  assert.ok(imported.json().binding.parityMismatches.some(reason => reason.includes('deadline has expired')));
  assert.equal(verifyCalls, 1);
  assert.equal((await call(handler, request(CIRCLE_CYCLE_IMPORT_PATH, { circleId }, 'not-owner.near'))).statusCode, 403);
  store.close();
});

test('verified cycle import explains creator-only denial without weakening authorization', async () => {
  const store = new ApplicationStore();
  const handler = createCirclePolicyHandler({ store, authenticateRequest: async req => req.subject ? { subject: req.subject } : null, clock: () => 1000 });
  const created = await call(handler, request(CIRCLE_CREATE_PATH, { contractId: 'creator-only.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 }, 'creator.near'));
  assert.equal(created.statusCode, 201);
  const circleId = created.json().circle.circleId;
  store.upsertMember({ memberId: 'other-member', principalId: 'member.near', nearAccount: 'member.near' });
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: 'other-member', accepted: true });
  store.joinCircleAfterPolicyAcceptance({ circleId, memberId: 'other-member' });
  const denied = await call(handler, request(CIRCLE_CYCLE_IMPORT_PATH, { circleId }, 'member.near'));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'CIRCLE_CREATOR_REQUIRED');
  assert.equal(denied.json().creatorAccountId, 'creator.near');
  assert.match(denied.json().message, /creator wallet/);
  store.close();
});

test('cycle configure route requires creator, active-member count, and a valid future schedule', async () => {
  const store = new ApplicationStore();
  const handler = createCirclePolicyHandler({ store, authenticateRequest: async req => req.subject ? { subject: req.subject } : null, clock: () => 1000 });
  const created = await call(handler, request(CIRCLE_CREATE_PATH, { contractId: 'schedule-api.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 }, 'creator.near'));
  const circleId = created.json().circle.circleId;
  const ownerId = created.json().circle.creatorMemberId;
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: ownerId, accepted: true });
  const tooFew = await call(handler, request(CIRCLE_CYCLE_CONFIGURE_PATH, { circleId, rounds: [{ contributionAmount: '100', deadlineMs: 2000 }, { contributionAmount: '100', deadlineMs: 3000 }] }, 'creator.near'));
  assert.equal(tooFew.statusCode, 409);
  store.upsertMember({ memberId: 'schedule-api-member', principalId: 'member.near', nearAccount: 'member.near' });
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: 'schedule-api-member', accepted: true });
  store.joinCircleAfterPolicyAcceptance({ circleId, memberId: 'schedule-api-member' });
  const configured = await call(handler, request(CIRCLE_CYCLE_CONFIGURE_PATH, { circleId, rounds: [
    { contributionAmount: '100', deadlineMs: 2000, deadlineNs: '2000000001' },
    { contributionAmount: '100', deadlineMs: 3000, deadlineNs: '3000000003' },
  ] }, 'creator.near'));
  assert.equal(configured.statusCode, 201);
  assert.equal(configured.json().cycle.ready, true);
  assert.deepEqual(store.db.prepare('SELECT deadline_ms,deadline_ns FROM app_rounds WHERE circle_id=? ORDER BY round_number').all(circleId)
    .map(row => [row.deadline_ms, row.deadline_ns]), [
    [2000, '2000000001'],
    [3000, '3000000003'],
  ]);
  const invalidExactSchedule = await call(handler, request(CIRCLE_CYCLE_CONFIGURE_PATH, { circleId, rounds: [
    { contributionAmount: '100', deadlineMs: 4000, deadlineNs: '4000000000' },
    { contributionAmount: '100', deadlineMs: 5000, deadlineNs: '3999999999' },
  ] }, 'creator.near'));
  assert.equal(invalidExactSchedule.statusCode, 400);
  const secondConfigure = await call(handler, request(CIRCLE_CYCLE_CONFIGURE_PATH, { circleId, rounds: [{ contributionAmount: '100', deadlineMs: 4000 }, { contributionAmount: '100', deadlineMs: 5000 }] }, 'member.near'));
  assert.equal(secondConfigure.statusCode, 403);
  store.close();
});
