import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationStore } from './application-store.mjs';
import { createApplicationContextResolvers } from './application-context-adapter.mjs';

function seed(store) {
  store.upsertCircle({ circleId: 'circle-1', contractId: 'circle-contract.near' });
  store.upsertMember({ memberId: 'member-1', principalId: 'auth-user-1', nearAccount: 'alice.near' });
  store.setMembership({ circleId: 'circle-1', memberId: 'member-1' });
  store.setRound({
    circleId: 'circle-1', round: 2, status: 'OPEN',
    contributionAmount: '1000000000000000000000000', deadlineMs: 1900000000000,
  });
  store.setCircleAsset({ circleId: 'circle-1', assetId: 'asset:usdc-base', maxInputAmount: '5000000' });
  store.setRefundAddress({ memberId: 'member-1', assetId: 'asset:usdc-base', address: '0xregistered' });
}

test('SQLite repository resolves a verified principal to active membership', async () => {
  const store = new ApplicationStore();
  seed(store);
  const resolvers = createApplicationContextResolvers({
    repository: store,
    getPrincipalId: principal => principal.subject,
  });
  assert.equal(await resolvers.resolveMemberIdentity({
    principal: { subject: 'auth-user-1' }, circleId: 'circle-1',
  }), 'member-1');
  store.close();
});

test('resolves context and only enables assets with both circle approval and registered refund address', async () => {
  const store = new ApplicationStore();
  seed(store);
  store.setCircleAsset({ circleId: 'circle-1', assetId: 'asset:no-refund', maxInputAmount: '900' });
  store.setRefundAddress({ memberId: 'member-1', assetId: 'asset:inactive', address: '0xinactive', active: false });
  store.setCircleAsset({ circleId: 'circle-1', assetId: 'asset:inactive', maxInputAmount: '900' });
  const resolvers = createApplicationContextResolvers({
    repository: store,
    getPrincipalId: principal => principal.subject,
  });
  assert.equal(await resolvers.resolveMemberIdentity({
    principal: { subject: 'auth-user-1' }, circleId: 'circle-1',
  }), 'member-1');
  const ctx = await resolvers.resolveTrustedContext({ circleId: 'circle-1', memberId: 'member-1', round: 2 });
  assert.equal(ctx.memberNearAccount, 'alice.near');
  assert.equal(ctx.requiredContributionAmount, '1000000000000000000000000');
  // A registered address is not proof of control; unverified addresses must not unlock quotes.
  assert.deepEqual(ctx.allowedOriginAssets, []);
  assert.deepEqual(ctx.refundAddresses, {});
  assert.deepEqual(ctx.maxInputAmounts, {});
  store.close();
});

test('fails closed for inactive circle, suspended membership, closed round, and unknown records', async () => {
  const store = new ApplicationStore();
  seed(store);
  const resolvers = createApplicationContextResolvers({
    repository: store,
    getPrincipalId: principal => principal.subject,
  });
  store.setMembership({ circleId: 'circle-1', memberId: 'member-1', status: 'SUSPENDED' });
  assert.equal(await resolvers.resolveMemberIdentity({
    principal: { subject: 'auth-user-1' }, circleId: 'circle-1',
  }), null);
  assert.equal(await resolvers.resolveTrustedContext({ circleId: 'circle-1', memberId: 'member-1', round: 2 }).then(x => x.memberStatus), 'SUSPENDED');

  store.setMembership({ circleId: 'circle-1', memberId: 'member-1', status: 'ACTIVE' });
  store.setRound({ circleId: 'circle-1', round: 2, status: 'CLOSED', contributionAmount: '1000000000000000000000000', deadlineMs: 1900000000000 });
  assert.equal((await resolvers.resolveTrustedContext({ circleId: 'circle-1', memberId: 'member-1', round: 2 })).roundStatus, 'CLOSED');

  store.upsertCircle({ circleId: 'circle-1', contractId: 'circle-contract.near', status: 'INACTIVE' });
  assert.equal(await resolvers.resolveMemberIdentity({
    principal: { subject: 'auth-user-1' }, circleId: 'circle-1',
  }), null);
  const inactiveContext = await resolvers.resolveTrustedContext({ circleId: 'circle-1', memberId: 'member-1', round: 2 });
  assert.equal(inactiveContext.circleStatus, 'INACTIVE');
  assert.equal(await resolvers.resolveTrustedContext({ circleId: 'unknown', memberId: 'member-1', round: 2 }), null);
  store.close();
});

test('persists application metadata when SQLite file is reopened', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ajo-app-store-'));
  const path = join(directory, 'application.sqlite');
  try {
    let store = new ApplicationStore({ path });
    seed(store);
    store.close();
    store = new ApplicationStore({ path });
    const context = store.getMemberQuoteContext({ circleId: 'circle-1', memberId: 'member-1', round: 2 });
    assert.equal(context.contractId, 'circle-contract.near');
    assert.equal(context.roundDeadlineMs, 1900000000000);
    assert.equal(context.roundDeadlineNs, '1900000000000000000');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates legacy millisecond deadlines to exact nanosecond strings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ajo-app-migration-'));
  const path = join(directory, 'application.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE app_rounds (
      circle_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      contribution_amount TEXT NOT NULL,
      deadline_ms INTEGER NOT NULL,
      PRIMARY KEY(circle_id, round_number)
    )`);
    legacy.prepare('INSERT INTO app_rounds(circle_id,round_number,status,contribution_amount,deadline_ms) VALUES(?,?,?,?,?)')
      .run('legacy-circle', 0, 'OPEN', '100', 1900000000000);
    legacy.close();

    const store = new ApplicationStore({ path });
    const migrated = store.db.prepare('SELECT deadline_ms,deadline_ns FROM app_rounds WHERE circle_id=? AND round_number=0').get('legacy-circle');
    assert.equal(migrated.deadline_ms, 1900000000000);
    assert.equal(migrated.deadline_ns, '1900000000000000000');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects invalid amounts, statuses, and unsafe round numbers', () => {
  const store = new ApplicationStore();
  assert.throws(() => store.setRound({
    circleId: 'circle-1', round: -1, contributionAmount: '10', deadlineMs: 10,
  }), /round/);
  assert.throws(() => store.setRound({
    circleId: 'circle-1', round: 0, contributionAmount: '0', deadlineMs: 10,
  }), /positive integer/);
  assert.throws(() => store.upsertCircle({
    circleId: 'circle-1', contractId: 'circle-contract.near', status: 'FAKE',
  }), /unsupported status/);
  store.close();
});

test('persists immutable circle policies and explicit version-bound member acceptance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ajo-policy-store-'));
  const path = join(directory, 'application.sqlite');
  try {
    let store = new ApplicationStore({ path, clock: () => '2026-10-21T09:00:00.000Z' });
    store.upsertCircle({ circleId: 'public-circle', contractId: 'public.testnet' });
    store.upsertCircle({ circleId: 'private-circle', contractId: 'private.testnet' });
    store.upsertMember({ memberId: 'member-1', principalId: 'auth-user-1', nearAccount: 'alice.near' });

    const publicPolicy = store.createCirclePolicy({ circleId: 'public-circle', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
    assert.equal(publicPolicy.publiclyDiscoverable, true);
    assert.equal(publicPolicy.penaltyBps, 500);
    assert.match(publicPolicy.policyHash, /^[a-f0-9]{64}$/);

    const privatePolicy = store.createCirclePolicy({ circleId: 'private-circle', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 });
    assert.equal(privatePolicy.invitationOnly, true);
    assert.equal(privatePolicy.publiclyDiscoverable, false);
    assert.equal(privatePolicy.penaltyBps, 0);
    assert.throws(() => store.recordCirclePolicyAcceptance({ circleId: 'public-circle', policyVersion: 1, memberId: 'member-1', accepted: false }), /explicit policy acceptance/);
    store.recordCirclePolicyAcceptance({ circleId: 'public-circle', policyVersion: 1, memberId: 'member-1', accepted: true });
    assert.equal(store.hasAcceptedCirclePolicy({ circleId: 'public-circle', policyVersion: 1, memberId: 'member-1' }), true);
    assert.equal(store.hasAcceptedCirclePolicy({ circleId: 'public-circle', policyVersion: 1, memberId: 'unknown-member' }), false);
    assert.equal(store.getCirclePolicy({ circleId: 'missing-circle' }), null);
    store.close();

    store = new ApplicationStore({ path });
    assert.equal(store.hasAcceptedCirclePolicy({ circleId: 'public-circle', policyVersion: 1, memberId: 'member-1' }), true);
    assert.equal(store.getCirclePolicy({ circleId: 'public-circle', policyVersion: 1 }).policyHash, publicPolicy.policyHash);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('policy versions are sequential and cannot change after round configuration', () => {
  const store = new ApplicationStore();
  store.upsertCircle({ circleId: 'circle-policy', contractId: 'circle-policy.testnet' });
  assert.throws(() => store.createCirclePolicy({ circleId: 'circle-policy', policyVersion: 2, mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 }), /policyVersion must be 1/);
  store.createCirclePolicy({ circleId: 'circle-policy', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 });
  store.setRound({ circleId: 'circle-policy', round: 0, contributionAmount: '100', deadlineMs: 1900000000000 });
  assert.throws(() => store.createCirclePolicy({ circleId: 'circle-policy', policyVersion: 2, mode: 'PRIVATE_TRUSTED', gracePeriodDays: 6 }), /cannot be changed after rounds are configured/);
  store.close();
});

test('policy store rejects public partial payouts, non-5% public penalties, and missing references', () => {
  const store = new ApplicationStore();
  store.upsertCircle({ circleId: 'circle-policy', contractId: 'circle-policy.testnet' });
  assert.throws(() => store.createCirclePolicy({ circleId: 'circle-policy', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5, penaltyBps: 400 }), /penaltyBps/);
  assert.throws(() => store.createCirclePolicy({ circleId: 'circle-policy', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5, shortfallPolicy: 'ALLOW_PARTIAL_PAYOUT' }), /must wait for the full pot/);
  assert.throws(() => store.createCirclePolicy({ circleId: 'missing', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 }), /circle does not exist/);
  assert.throws(() => store.recordCirclePolicyAcceptance({ circleId: 'circle-policy', policyVersion: 1, memberId: 'missing', accepted: true }), /policy version does not exist/);
  store.close();
});

test('circle join requires explicit acceptance of the latest published policy', () => {
  const store = new ApplicationStore();
  store.upsertCircle({ circleId: 'join-circle', contractId: 'join.testnet' });
  store.upsertMember({ memberId: 'join-member', principalId: 'join-user', nearAccount: 'joiner.near' });
  assert.throws(() => store.joinCircleAfterPolicyAcceptance({ circleId: 'join-circle', memberId: 'join-member' }), /no published policy/);
  store.createCirclePolicy({ circleId: 'join-circle', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  assert.throws(() => store.joinCircleAfterPolicyAcceptance({ circleId: 'join-circle', memberId: 'join-member' }), /must accept the current circle policy/);
  store.recordCirclePolicyAcceptance({ circleId: 'join-circle', policyVersion: 1, memberId: 'join-member', accepted: true });
  assert.deepEqual(store.joinCircleAfterPolicyAcceptance({ circleId: 'join-circle', memberId: 'join-member' }), {
    circleId: 'join-circle', memberId: 'join-member', policyVersion: 1, status: 'ACTIVE',
  });
  assert.equal(store.findMembershipForPrincipal({ principalId: 'join-user', circleId: 'join-circle' }).status, 'ACTIVE');
  store.close();
});

test('private invitations are one-time, expiring, revocable, and require the accepted policy', () => {
  const store = new ApplicationStore();
  store.upsertCircle({ circleId: 'private-invite-circle', contractId: 'private-invite.testnet' });
  store.upsertMember({ memberId: 'creator', principalId: 'creator-user', nearAccount: 'creator.near' });
  store.upsertMember({ memberId: 'invitee-1', principalId: 'invitee-user-1', nearAccount: 'invitee1.near' });
  store.upsertMember({ memberId: 'invitee-2', principalId: 'invitee-user-2', nearAccount: 'invitee2.near' });
  store.createCirclePolicy({ circleId: 'private-invite-circle', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 });
  store.setMembership({ circleId: 'private-invite-circle', memberId: 'creator', status: 'ACTIVE' });
  const invite = store.createCircleInvitation({ circleId: 'private-invite-circle', createdByMemberId: 'creator', expiresAtMs: 2000, maxUses: 1, nowMs: 1000 });
  assert.match(invite.token, /^[A-Za-z0-9_-]{40,}$/);
  store.recordCirclePolicyAcceptance({ circleId: 'private-invite-circle', policyVersion: 1, memberId: 'invitee-1', accepted: true });
  assert.equal(store.joinCircleAfterPolicyAcceptance({ circleId: 'private-invite-circle', memberId: 'invitee-1', inviteToken: invite.token, nowMs: 1500 }).status, 'ACTIVE');
  store.recordCirclePolicyAcceptance({ circleId: 'private-invite-circle', policyVersion: 1, memberId: 'invitee-2', accepted: true });
  assert.throws(() => store.joinCircleAfterPolicyAcceptance({ circleId: 'private-invite-circle', memberId: 'invitee-2', inviteToken: invite.token, nowMs: 1500 }), /invalid, expired, revoked, or already used/);
  assert.equal(store.findMembershipForPrincipal({ principalId: 'invitee-user-2', circleId: 'private-invite-circle' }), null);

  const expiring = store.createCircleInvitation({ circleId: 'private-invite-circle', createdByMemberId: 'creator', expiresAtMs: 1600, maxUses: 1, nowMs: 1000 });
  assert.throws(() => store.revokeCircleInvitation({ circleId: 'private-invite-circle', createdByMemberId: 'invitee-1', token: expiring.token }), /active invitation not found/);
  assert.equal(store.revokeCircleInvitation({ circleId: 'private-invite-circle', createdByMemberId: 'creator', token: expiring.token }), true);
  assert.throws(() => store.joinCircleAfterPolicyAcceptance({ circleId: 'private-invite-circle', memberId: 'invitee-2', inviteToken: expiring.token, nowMs: 1500 }), /invalid, expired, revoked, or already used/);
  const expired = store.createCircleInvitation({ circleId: 'private-invite-circle', createdByMemberId: 'creator', expiresAtMs: 1600, maxUses: 1, nowMs: 1000 });
  assert.equal(store.getCircleInvitationContext({ circleId: 'private-invite-circle', token: expired.token, nowMs: 1599 }).usesRemaining, 1);
  assert.equal(store.getCircleInvitationContext({ circleId: 'private-invite-circle', token: expired.token, nowMs: 1600 }), null);
  assert.throws(() => store.joinCircleAfterPolicyAcceptance({ circleId: 'private-invite-circle', memberId: 'invitee-2', inviteToken: expired.token, nowMs: 1600 }), /invalid, expired, revoked, or already used/);
  store.close();
});

test('private invitations cannot be created for public circles or by non-members', () => {
  const store = new ApplicationStore();
  store.upsertCircle({ circleId: 'public-invite-circle', contractId: 'public-invite.testnet' });
  store.upsertCircle({ circleId: 'private-invite-circle', contractId: 'private-invite.testnet' });
  store.upsertMember({ memberId: 'member', principalId: 'member-user', nearAccount: 'member.near' });
  store.createCirclePolicy({ circleId: 'public-invite-circle', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  store.createCirclePolicy({ circleId: 'private-invite-circle', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 });
  assert.throws(() => store.createCircleInvitation({ circleId: 'public-invite-circle', createdByMemberId: 'member', expiresAtMs: 2000, nowMs: 1000 }), /only available for private trusted circles/);
  assert.throws(() => store.createCircleInvitation({ circleId: 'private-invite-circle', createdByMemberId: 'member', expiresAtMs: 2000, nowMs: 1000 }), /only an active member/);
  store.close();
});

test('cycle cannot start until every active member accepts policy and all rounds are configured', () => {
  const store = new ApplicationStore({ clock: () => new Date(1000).toISOString() });
  store.upsertCircle({ circleId: 'cycle-gate', contractId: 'cycle-gate.testnet' });
  store.upsertMember({ memberId: 'cycle-owner', principalId: 'cycle-owner-user', nearAccount: 'cycle-owner.near' });
  store.upsertMember({ memberId: 'cycle-member', principalId: 'cycle-member-user', nearAccount: 'cycle-member.near' });
  store.createCirclePolicy({ circleId: 'cycle-gate', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  store.setMembership({ circleId: 'cycle-gate', memberId: 'cycle-owner' });
  store.setMembership({ circleId: 'cycle-gate', memberId: 'cycle-member' });
  const draft = store.provisionCircleCycle({ circleId: 'cycle-gate', createdByMemberId: 'cycle-owner', plannedRounds: 2 });
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.ready, false);
  store.setRound({ circleId: 'cycle-gate', round: 0, contributionAmount: '1000000000000000000000000', deadlineMs: 2000 });
  store.setRound({ circleId: 'cycle-gate', round: 1, contributionAmount: '1000000000000000000000000', deadlineMs: 3000 });
  assert.throws(() => store.startCircleCycle({ circleId: 'cycle-gate', requestedByMemberId: 'cycle-owner', nowMs: 1000 }), /every active member must accept/);
  assert.equal(store.getMemberQuoteContext({ circleId: 'cycle-gate', memberId: 'cycle-owner', round: 0 }), null);
  store.recordCirclePolicyAcceptance({ circleId: 'cycle-gate', policyVersion: 1, memberId: 'cycle-owner', accepted: true });
  store.recordCirclePolicyAcceptance({ circleId: 'cycle-gate', policyVersion: 1, memberId: 'cycle-member', accepted: true });
  assert.equal(store.getCircleCycleStatus({ circleId: 'cycle-gate' }).ready, true);
  assert.throws(() => store.startCircleCycle({ circleId: 'cycle-gate', requestedByMemberId: 'cycle-member', nowMs: 1000 }), /only the cycle creator/);
  const started = store.startCircleCycle({ circleId: 'cycle-gate', requestedByMemberId: 'cycle-owner', nowMs: 1000 });
  assert.equal(started.status, 'STARTED');
  assert.equal(started.startedAt, new Date(1000).toISOString());
  assert.notEqual(store.getMemberQuoteContext({ circleId: 'cycle-gate', memberId: 'cycle-owner', round: 0 }), null);
  assert.throws(() => store.startCircleCycle({ circleId: 'cycle-gate', requestedByMemberId: 'cycle-owner', nowMs: 2000 }), /not in DRAFT state/);
  assert.throws(() => store.setRound({ circleId: 'cycle-gate', round: 2, contributionAmount: '1000000000000000000000000', deadlineMs: 4000 }), /cannot change after the circle cycle starts/);
  assert.throws(() => store.setMembership({ circleId: 'cycle-gate', memberId: 'late-member' }), /cannot change after the circle cycle starts/);
  store.close();
});

test('cycle start rejects mismatched round count and non-increasing deadlines', () => {
  const store = new ApplicationStore();
  store.upsertCircle({ circleId: 'cycle-invalid', contractId: 'cycle-invalid.testnet' });
  store.upsertMember({ memberId: 'cycle-invalid-owner', principalId: 'cycle-invalid-owner-user', nearAccount: 'cycle-invalid-owner.near' });
  store.upsertMember({ memberId: 'cycle-invalid-member', principalId: 'cycle-invalid-member-user', nearAccount: 'cycle-invalid-member.near' });
  store.createCirclePolicy({ circleId: 'cycle-invalid', mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5 });
  store.setMembership({ circleId: 'cycle-invalid', memberId: 'cycle-invalid-owner' });
  store.setMembership({ circleId: 'cycle-invalid', memberId: 'cycle-invalid-member' });
  store.recordCirclePolicyAcceptance({ circleId: 'cycle-invalid', policyVersion: 1, memberId: 'cycle-invalid-owner', accepted: true });
  store.recordCirclePolicyAcceptance({ circleId: 'cycle-invalid', policyVersion: 1, memberId: 'cycle-invalid-member', accepted: true });
  store.provisionCircleCycle({ circleId: 'cycle-invalid', createdByMemberId: 'cycle-invalid-owner', plannedRounds: 2 });
  store.setRound({ circleId: 'cycle-invalid', round: 0, contributionAmount: '100', deadlineMs: 2000 });
  assert.throws(() => store.startCircleCycle({ circleId: 'cycle-invalid', requestedByMemberId: 'cycle-invalid-owner', nowMs: 1000 }), /every planned round must be configured/);
  store.setRound({ circleId: 'cycle-invalid', round: 1, contributionAmount: '100', deadlineMs: 2000 });
  assert.throws(() => store.startCircleCycle({ circleId: 'cycle-invalid', requestedByMemberId: 'cycle-invalid-owner', nowMs: 1000 }), /strictly increasing/);
  store.close();
});

test('user-created circle setup stores immutable policy and requires explicit creator acceptance', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({
    principalId: 'creator.near', nearAccount: 'creator.near', contractId: 'new-circle.testnet',
    mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5,
  });
  assert.match(created.circleId, /^[0-9a-f-]{36}$/);
  assert.equal(created.policy.mode, 'PRIVATE_TRUSTED');
  assert.equal(created.policy.invitationOnly, true);
  assert.equal(store.findMembershipForPrincipal({ principalId: 'creator.near', circleId: created.circleId }).status, 'ACTIVE');
  assert.equal(store.hasAcceptedCirclePolicy({ circleId: created.circleId, policyVersion: 1, memberId: created.creatorMemberId }), false);
  assert.throws(() => store.createCircleForPrincipal({
    principalId: 'another.near', nearAccount: 'another.near', contractId: 'new-circle.testnet',
    mode: 'PRIVATE_TRUSTED', gracePeriodDays: 5,
  }), /already registered/);
  store.close();
});

test('verified contract binding is creator-only, matches the registered ID and policy mode, and keeps quotes fail-closed', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({
    principalId: 'verify-owner.near', nearAccount: 'verify-owner.near', contractId: 'verified-circle.testnet',
    mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  });
  const context = store.getCircleContractVerificationContext({ circleId: created.circleId, requestedByMemberId: created.creatorMemberId });
  assert.equal(context.contractId, 'verified-circle.testnet');
  assert.throws(() => store.getCircleContractVerificationContext({ circleId: created.circleId, requestedByMemberId: 'other-member' }), /only the circle creator/);
  const verification = {
    verified: true, contractId: 'verified-circle.testnet', network: 'testnet',
    codeSha256: '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0',
    mode: 'ProtectedPublic', currentRound: 0, roundDeadline: '1800000000000000000', contributionCount: 0,
    currentRecipient: 'recipient.testnet', circleCompleted: false, payoutPending: false, payoutComplete: false,
    requiredProtection: '3000000000000000000000000', verifiedAt: '2026-10-21T10:00:00.000Z',
    quoteReady: false, quoteReadinessReason: 'Cannot yet prove local schedule matches contract configuration.',
  };
  assert.throws(() => store.recordVerifiedContractBinding({ circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification: { ...verification, contractId: 'other.testnet' } }), /does not match the registered/);
  assert.throws(() => store.recordVerifiedContractBinding({ circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification: { ...verification, mode: 'Private' } }), /mode does not match/);
  assert.throws(() => store.recordVerifiedContractBinding({ circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification: { ...verification, codeSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), /hash is not approved/);
  const binding = store.recordVerifiedContractBinding({ circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification });
  assert.equal(binding.contractId, 'verified-circle.testnet');
  assert.equal(binding.codeSha256, verification.codeSha256);
  assert.equal(binding.quoteReady, false);
  store.close();
});

test('draft-cycle binding diagnostics preserve on-chain terminal-state blockers', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({ principalId: 'draft-owner.near', nearAccount: 'draft-owner.near',
    contractId: 'draft-lifecycle.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  const circleId = created.circleId;
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: created.creatorMemberId, accepted: true });
  store.upsertMember({ memberId: 'draft-lifecycle-member', principalId: 'draft-member.near', nearAccount: 'draft-member.near' });
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: 'draft-lifecycle-member', accepted: true });
  store.joinCircleAfterPolicyAcceptance({ circleId, memberId: 'draft-lifecycle-member' });
  const members = ['draft-owner.near', 'draft-member.near'];
  store.configureCircleContractSchedule({ circleId, creatorMemberId: created.creatorMemberId,
    members, payoutOrder: members, treasurerAgent: 'draft-lifecycle.testnet' });
  const contributionAmount = '1000000000000000000000000';
  const rounds = [
    { round: 0, contributionAmount, deadlineNs: '1800000000000000000' },
    { round: 1, contributionAmount, deadlineNs: '1800000003000000000' },
  ];
  store.configureCircleCycle({ circleId, createdByMemberId: created.creatorMemberId,
    rounds: rounds.map(round => ({ contributionAmount: round.contributionAmount, deadlineNs: round.deadlineNs,
      deadlineMs: Number(BigInt(round.deadlineNs) / 1000000n) })) });
  const verification = {
    verified: true, contractId: 'draft-lifecycle.testnet', network: 'testnet',
    codeSha256: '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0',
    mode: 'ProtectedPublic', currentRound: 0, roundDeadline: rounds[0].deadlineNs, contributionCount: 2,
    currentRecipient: members[0], circleCompleted: false, payoutPending: false, payoutComplete: true,
    requiredProtection: '0', verifiedAt: new Date().toISOString(),
    members, memberCount: 2, contributionAmount, payoutOrder: members, treasurerAgent: 'draft-lifecycle.testnet', rounds,
    quoteReady: false, quoteReadinessReason: 'Read-only evidence.',
  };
  const binding = store.recordVerifiedContractBinding({ circleId, creatorMemberId: created.creatorMemberId, verification });
  assert.equal(binding.quoteReady, false);
  assert.ok(binding.parityMismatches.some(reason => reason.includes('Cycle must be started')));
  assert.ok(binding.parityMismatches.some(reason => reason.includes('contract lifecycle is not eligible')));
  assert.match(binding.quoteReadinessReason, /payoutComplete|contract lifecycle/i);
  store.close();
});

test('imports an existing advanced on-chain cycle without resetting rounds and keeps expired deadlines fail-closed', () => {
  const store = new ApplicationStore();
  const nowMs = Date.parse('2026-10-23T22:10:06.699Z');
  const created = store.createCircleForPrincipal({
    principalId: 'ajocircle.testnet', nearAccount: 'ajocircle.testnet', contractId: 'ajo-demo-cycle4.testnet',
    mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  });
  const members = ['ajotest1.testnet', 'ajotest2.testnet', 'ajotest3.testnet'];
  for (const [index, account] of members.entries()) {
    const member = store.ensureMemberForPrincipal({ principalId: account, nearAccount: account });
    store.recordCirclePolicyAcceptance({ circleId: created.circleId, policyVersion: 1, memberId: member.memberId, accepted: true });
    store.joinCircleAfterPolicyAcceptance({ circleId: created.circleId, memberId: member.memberId });
  }
  store.configureCircleContractSchedule({
    circleId: created.circleId, creatorMemberId: created.creatorMemberId,
    members, payoutOrder: members, treasurerAgent: 'ajo-demo-cycle4.testnet',
  });
  const contributionAmount = '1000000000000000000000000';
  const rounds = [
    { round: 0, contributionAmount, deadlineNs: '1792782860310766325' },
    { round: 1, contributionAmount, deadlineNs: '1792787486459000000' },
    { round: 2, contributionAmount, deadlineNs: '1792792988794398962' },
  ];
  const verification = {
    verified: true, network: 'testnet', contractId: 'ajo-demo-cycle4.testnet',
    codeSha256: 'b1edaeea67c59477155330de826c219e9731361de61a4faf29b28382365b3cf6',
    mode: 'ProtectedPublic', currentRound: 2, roundDeadline: rounds[2].deadlineNs, contributionCount: 1,
    currentRecipient: 'ajotest3.testnet', circleCompleted: false, payoutPending: false, payoutComplete: false,
    requiredProtection: '0', verifiedAt: new Date(nowMs).toISOString(),
    members, memberCount: 3, contributionAmount, payoutOrder: members, treasurerAgent: 'ajo-demo-cycle4.testnet',
    rounds, roundDeadlines: rounds.map(round => round.deadlineNs),
    quoteReady: false, quoteReadinessReason: 'Read-only verification.',
  };
  const cycle = store.importVerifiedContractCycle({
    circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification, nowMs,
  });
  assert.equal(cycle.status, 'STARTED');
  assert.equal(cycle.plannedRounds, 3);
  const parity = store.getCircleScheduleParityContext({ circleId: created.circleId });
  assert.equal(parity.ready, true);
  assert.equal(parity.local.currentRound, 2);
  assert.equal(parity.local.rounds.length, 3);
  const binding = store.recordVerifiedContractBinding({
    circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification,
  });
  assert.equal(binding.quoteReady, false);
  assert.ok(binding.parityMismatches.some(reason => reason.includes('deadline has expired')));
  assert.equal(store.db.prepare('SELECT status FROM app_rounds WHERE circle_id=? AND round_number=0').get(created.circleId).status, 'COMPLETE');
  assert.equal(store.db.prepare('SELECT status FROM app_rounds WHERE circle_id=? AND round_number=1').get(created.circleId).status, 'COMPLETE');
  assert.equal(store.db.prepare('SELECT status FROM app_rounds WHERE circle_id=? AND round_number=2').get(created.circleId).status, 'OPEN');
  store.close();
});

test('persisted local/on-chain schedule parity enables quotes only for an exact started-cycle match', () => {
  let now = '2026-10-21T10:00:00.000Z';
  const store = new ApplicationStore({ clock: () => now });
  const created = store.createCircleForPrincipal({
    principalId: 'creator.near', nearAccount: 'creator.near', contractId: 'parity-circle.testnet',
    mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  });
  store.recordCirclePolicyAcceptance({ circleId: created.circleId, policyVersion: 1, memberId: created.creatorMemberId, accepted: true });
  store.upsertMember({ memberId: 'parity-member', principalId: 'parity-member.near', nearAccount: 'parity-member.near' });
  store.recordCirclePolicyAcceptance({ circleId: created.circleId, policyVersion: 1, memberId: 'parity-member', accepted: true });
  store.joinCircleAfterPolicyAcceptance({ circleId: created.circleId, memberId: 'parity-member' });
  const members = ['creator.near', 'parity-member.near'];
  store.configureCircleContractSchedule({ circleId: created.circleId, creatorMemberId: created.creatorMemberId,
    members, payoutOrder: members, treasurerAgent: 'parity-circle.testnet' });
  store.configureCircleCycle({ circleId: created.circleId, createdByMemberId: created.creatorMemberId,
    rounds: [
      { contributionAmount: '1000000000000000000000000', deadlineMs: 1800000000000, deadlineNs: '1800000000000000001' },
      { contributionAmount: '1000000000000000000000000', deadlineMs: 1800000003000, deadlineNs: '1800000003000000003' },
    ] });
  store.startCircleCycle({ circleId: created.circleId, requestedByMemberId: created.creatorMemberId, nowMs: 1700000000000 });
  const verification = {
    verified: true, contractId: 'parity-circle.testnet', network: 'testnet',
    codeSha256: '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0',
    mode: 'ProtectedPublic', currentRound: 0, roundDeadline: '1800000000000000001', contributionCount: 0,
    currentRecipient: 'creator.near', circleCompleted: false, payoutPending: false, payoutComplete: false,
    requiredProtection: '3000000000000000000000000', verifiedAt: '2026-10-21T10:00:00.000Z',
    members, memberCount: 2, contributionAmount: '1000000000000000000000000', payoutOrder: members,
    treasurerAgent: 'parity-circle.testnet',
    rounds: [
      { round: 0, contributionAmount: '1000000000000000000000000', deadlineNs: '1800000000000000001' },
      { round: 1, contributionAmount: '1000000000000000000000000', deadlineNs: '1800000003000000003' },
    ],
    quoteReady: false, quoteReadinessReason: 'Read-only evidence; parity is required.',
  };
  const binding = store.recordVerifiedContractBinding({ circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification });
  assert.equal(binding.quoteReady, true);
  assert.deepEqual(binding.parityMismatches, []);
  assert.equal(binding.verification.rounds.length, 2);
  const quoteContext = store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 0 });
  assert.notEqual(quoteContext, null, 'the binding should authorize only its exact verified current round');
  assert.equal(quoteContext.roundDeadlineNs, '1800000000000000001');
  now = '2026-10-21T10:01:00.000Z';
  assert.notEqual(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 0 }), null,
    'verification remains fresh at exactly 60 seconds');
  now = '2026-10-21T10:01:00.001Z';
  assert.equal(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 0 }), null,
    'verification older than 60 seconds must not authorize a quote');
  const staleBinding = store.getVerifiedContractBinding({ circleId: created.circleId });
  assert.equal(staleBinding.quoteReady, false, 'a stale binding must be invalidated in persistent state');
  assert.match(staleBinding.quoteReadinessReason, /stale or has an invalid verification timestamp/);
  now = '2026-10-21T10:00:00.000Z';
  assert.equal(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 1 }), null,
    'a verified binding for round 0 must not authorize a quote for round 1');
  const changedSchedule = { ...verification, rounds: [verification.rounds[0], { ...verification.rounds[1], deadlineNs: '1800000004000000000' }] };
  const mismatch = store.recordVerifiedContractBinding({ circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification: changedSchedule });
  assert.equal(mismatch.quoteReady, false);
  assert.ok(mismatch.parityMismatches.some(reason => reason.includes('round 1 deadline differs')));

  // A fresh binding must still stop authorizing quotes once the deadline passes.
  const justBeforeDeadline = new Date(1800000000000 - 30_000).toISOString();
  now = justBeforeDeadline;
  const freshNearDeadline = { ...verification, verifiedAt: justBeforeDeadline };
  const nearDeadlineBinding = store.recordVerifiedContractBinding({
    circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification: freshNearDeadline,
  });
  assert.equal(nearDeadlineBinding.quoteReady, true);
  assert.equal(nearDeadlineBinding.scheduleParityMatches, true);
  assert.deepEqual(nearDeadlineBinding.scheduleParityMismatches, []);
  assert.equal(nearDeadlineBinding.lifecycleEligible, true);
  assert.deepEqual(nearDeadlineBinding.lifecycleBlockers, []);
  assert.notEqual(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 0 }), null,
    'quote context is available before the deadline');
  now = new Date(1800000000000 + 1).toISOString();
  assert.equal(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 0 }), null,
    'a fresh cached binding must not authorize a quote after the actual round deadline');
  const expiredBinding = store.getVerifiedContractBinding({ circleId: created.circleId });
  assert.equal(expiredBinding.quoteReady, false, 'an expired deadline must invalidate persisted quote readiness');
  assert.match(expiredBinding.quoteReadinessReason, /deadline has expired/);
  assert.equal(store.invalidateQuoteReadiness({ circleId: created.circleId, reason: 'Live contract state changed.' }), true);
  const invalidated = store.getVerifiedContractBinding({ circleId: created.circleId });
  assert.equal(invalidated.quoteReady, false);
  assert.equal(invalidated.quoteReadinessReason, 'Live contract state changed.');
  assert.deepEqual(invalidated.parityMismatches, ['Live contract state changed.']);

  // Terminal lifecycle evidence must independently block quotes even when the local schedule matches.
  now = '2026-10-21T10:00:00.000Z';
  for (const lifecycle of [
    { circleCompleted: true, payoutPending: false, payoutComplete: false },
    { circleCompleted: false, payoutPending: true, payoutComplete: false },
    { circleCompleted: false, payoutPending: false, payoutComplete: true },
  ]) {
    const terminal = store.recordVerifiedContractBinding({
      circleId: created.circleId,
      creatorMemberId: created.creatorMemberId,
      verification: { ...verification, ...lifecycle, verifiedAt: now },
    });
    assert.equal(terminal.quoteReady, false, `terminal lifecycle must block quotes: ${JSON.stringify(lifecycle)}`);
    assert.equal(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 0 }), null,
      `terminal lifecycle must not expose quote context: ${JSON.stringify(lifecycle)}`);
  }
  store.close();
});

test('completed local cycles report a terminal quote-blocking reason', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({
    principalId: 'completed-owner.near', nearAccount: 'completed-owner.near',
    contractId: 'completed-cycle.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  });
  const participant = store.ensureMemberForPrincipal({ principalId: 'completed-member.near', nearAccount: 'completed-member.near' });
  store.setMembership({ circleId: created.circleId, memberId: participant.memberId, status: 'ACTIVE' });
  const members = ['completed-owner.near', 'completed-member.near'];
  store.configureCircleContractSchedule({ circleId: created.circleId, creatorMemberId: created.creatorMemberId,
    members, payoutOrder: members, treasurerAgent: 'completed-cycle.testnet' });
  store.configureCircleCycle({ circleId: created.circleId, createdByMemberId: created.creatorMemberId,
    rounds: [
      { contributionAmount: '100', deadlineMs: 1800000000000 },
      { contributionAmount: '100', deadlineMs: 1800000003000 },
    ] });
  store.db.prepare('UPDATE app_circle_cycles SET status=? WHERE circle_id=?').run('COMPLETED', created.circleId);
  const parity = store.getCircleScheduleParityContext({ circleId: created.circleId });
  assert.equal(parity.ready, false);
  assert.equal(parity.reason, 'Local cycle is completed; quote creation is blocked for this cycle.');

  // Matching terminal local and on-chain lifecycle must produce an explicit permanent quote blocker.
  store.db.prepare('UPDATE app_rounds SET status=? WHERE circle_id=?').run('COMPLETE', created.circleId);
  const deadlines = ['1800000000000000000', '1800000003000000000'];
  const terminalVerification = {
    verified: true, network: 'testnet', contractId: 'completed-cycle.testnet',
    codeSha256: '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0',
    mode: 'ProtectedPublic', currentRound: 1, roundDeadline: deadlines[1], contributionCount: 2,
    currentRecipient: 'completed-member.near', circleCompleted: true, payoutPending: false, payoutComplete: true,
    requiredProtection: '0', verifiedAt: '2026-10-21T10:00:00.000Z', quoteReadinessReason: 'Read-only terminal verification.',
    members, memberCount: 2, contributionAmount: '100', payoutOrder: members,
    treasurerAgent: 'completed-cycle.testnet',
    rounds: deadlines.map((deadlineNs, round) => ({ round, contributionAmount: '100', deadlineNs })),
    roundDeadlines: deadlines,
  };
  const binding = store.recordVerifiedContractBinding({
    circleId: created.circleId, creatorMemberId: created.creatorMemberId, verification: terminalVerification,
  });
  assert.equal(binding.quoteReady, false);
  assert.equal(binding.scheduleParityMatches, true);
  assert.deepEqual(binding.scheduleParityMismatches, []);
  assert.equal(binding.lifecycleEligible, false);
  assert.ok(binding.lifecycleBlockers.includes('Local cycle is completed; quote creation is blocked for this cycle.'));
  assert.deepEqual(binding.parityMismatches, [
    'Local cycle is completed; quote creation is blocked for this cycle.',
    'On-chain circle and payout are complete; quote creation is permanently blocked for this cycle.',
  ]);
  assert.equal(binding.quoteReadinessReason,
    'Quote creation remains blocked: Local cycle is completed; quote creation is blocked for this cycle.; On-chain circle and payout are complete; quote creation is permanently blocked for this cycle.');
  assert.equal(store.getMemberQuoteContext({ circleId: created.circleId, memberId: created.creatorMemberId, round: 1 }), null);
  store.close();
});

test('schedule parity stays blocked when active membership changes after local expectations are saved', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({ principalId: 'owner-change.near', nearAccount: 'owner-change.near',
    contractId: 'membership-change.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  const second = store.ensureMemberForPrincipal({ principalId: 'second-change.near', nearAccount: 'second-change.near' });
  store.setMembership({ circleId: created.circleId, memberId: second.memberId, status: 'ACTIVE' });
  const expected = ['owner-change.near', 'second-change.near'];
  store.configureCircleContractSchedule({ circleId: created.circleId, creatorMemberId: created.creatorMemberId,
    members: expected, payoutOrder: expected, treasurerAgent: 'membership-change.testnet' });
  const third = store.ensureMemberForPrincipal({ principalId: 'third-change.near', nearAccount: 'third-change.near' });
  store.setMembership({ circleId: created.circleId, memberId: third.memberId, status: 'ACTIVE' });
  store.configureCircleCycle({ circleId: created.circleId, createdByMemberId: created.creatorMemberId,
    rounds: [
      { contributionAmount: '100', deadlineMs: 1800000000000 },
      { contributionAmount: '100', deadlineMs: 1800000003000 },
      { contributionAmount: '100', deadlineMs: 1800000006000 },
    ] });
  const parity = store.getCircleScheduleParityContext({ circleId: created.circleId });
  assert.equal(parity.ready, false);
  assert.match(parity.reason, /Active memberships changed/);
  store.close();
});

test('local schedule config must match active members and a payout-order permutation', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({ principalId: 'config-owner.near', nearAccount: 'config-owner.near',
    contractId: 'config-parity.testnet', mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5 });
  assert.throws(() => store.configureCircleContractSchedule({ circleId: created.circleId, creatorMemberId: created.creatorMemberId,
    members: ['someone.near', 'other.near'], payoutOrder: ['someone.near', 'other.near'], treasurerAgent: 'config-parity.testnet' }), /exactly match/);
  assert.throws(() => store.configureCircleContractSchedule({ circleId: created.circleId, creatorMemberId: created.creatorMemberId,
    members: ['config-owner.near', 'config-owner.near'], payoutOrder: ['config-owner.near', 'config-owner.near'], treasurerAgent: 'config-parity.testnet' }), /unique valid/);
  store.close();
});

test('cycle schedule configuration is creator-only, atomic, and matches active membership count', () => {
  const store = new ApplicationStore();
  const created = store.createCircleForPrincipal({
    principalId: 'creator.near', nearAccount: 'creator.near', contractId: 'schedule-circle.testnet',
    mode: 'PROTECTED_PUBLIC', gracePeriodDays: 5,
  });
  const circleId = created.circleId;
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: created.creatorMemberId, accepted: true });
  assert.throws(() => store.configureCircleCycle({
    circleId, createdByMemberId: created.creatorMemberId,
    rounds: [{ contributionAmount: '100', deadlineMs: 2000 }, { contributionAmount: '100', deadlineMs: 3000 }],
  }), /plannedRounds must equal/);
  assert.equal(store.getCircleCycleStatus({ circleId }), null);
  store.upsertMember({ memberId: 'schedule-member', principalId: 'schedule-member.near', nearAccount: 'schedule-member.near' });
  store.recordCirclePolicyAcceptance({ circleId, policyVersion: 1, memberId: 'schedule-member', accepted: true });
  store.joinCircleAfterPolicyAcceptance({ circleId, memberId: 'schedule-member' });
  assert.throws(() => store.configureCircleCycle({
    circleId, createdByMemberId: 'schedule-member',
    rounds: [{ contributionAmount: '100', deadlineMs: 2000 }, { contributionAmount: '100', deadlineMs: 3000 }],
  }), /only the circle creator/);
  const cycle = store.configureCircleCycle({
    circleId, createdByMemberId: created.creatorMemberId,
    rounds: [{ contributionAmount: '100', deadlineMs: 2000 }, { contributionAmount: '100', deadlineMs: 3000 }],
  });
  assert.equal(cycle.status, 'DRAFT');
  assert.equal(cycle.plannedRounds, 2);
  assert.equal(cycle.configuredRounds, 2);
  assert.equal(cycle.ready, true);
  assert.equal(store.startCircleCycle({ circleId, requestedByMemberId: created.creatorMemberId, nowMs: 1000 }).status, 'STARTED');
  assert.equal(store.getMemberQuoteContext({ circleId, memberId: created.creatorMemberId, round: 0 }), null);
  store.close();
});

test('NEAR refund wallet verification requires an authenticated account match', () => {
  const store = new ApplicationStore({ clock: () => '2026-10-27T12:00:00.000Z' });
  try {
    store.upsertCircle({ circleId: 'circle-1', contractId: 'circle-contract.near' });
    store.upsertMember({
      memberId: 'member-1',
      principalId: 'auth-user-1',
      nearAccount: 'alice.near'
    });
    store.setMembership({ circleId: 'circle-1', memberId: 'member-1' });
    store.setCircleAsset({
      circleId: 'circle-1',
      assetId: 'nep141:token.near',
      maxInputAmount: '1000'
    });
    store.setRefundAddress({
      memberId: 'member-1',
      assetId: 'nep141:token.near',
      address: 'alice.near'
    });

    const verified = store.verifyNearRefundAddressForPrincipal({
      principalId: 'auth-user-1',
      circleId: 'circle-1',
      assetId: 'nep141:token.near',
      address: 'alice.near'
    });

    assert.equal(verified.verificationStatus, 'VERIFIED');
    assert.equal(verified.memberId, 'member-1');
    assert.equal(verified.verificationMethod, 'NEAR_AUTHENTICATED_ACCOUNT_MATCH');

    const saved = store.db.prepare(`
      SELECT verification_status, verified_at, verification_method
      FROM app_member_refund_addresses
      WHERE member_id=? AND asset_id=?
    `).get('member-1', 'nep141:token.near');

    assert.equal(saved.verification_status, 'VERIFIED');
    assert.equal(saved.verified_at, '2026-10-27T12:00:00.000Z');
    assert.equal(saved.verification_method, 'NEAR_AUTHENTICATED_ACCOUNT_MATCH');

    assert.throws(() => store.verifyNearRefundAddressForPrincipal({
      principalId: 'auth-user-1',
      circleId: 'circle-1',
      assetId: 'nep141:token.near',
      address: 'mallory.near'
    }), /verification rejected/);

    assert.throws(() => store.verifyNearRefundAddressForPrincipal({
      principalId: 'auth-user-1',
      circleId: 'circle-1',
      assetId: 'asset:usdc-base',
      address: 'alice.near'
    }), /NEP-141/);

    store.setCircleAsset({
      circleId: 'circle-1',
      assetId: 'nep141:inactive.near',
      maxInputAmount: '1000',
      active: false
    });
    store.setRefundAddress({
      memberId: 'member-1',
      assetId: 'nep141:inactive.near',
      address: 'alice.near'
    });

    assert.throws(() => store.verifyNearRefundAddressForPrincipal({
      principalId: 'auth-user-1',
      circleId: 'circle-1',
      assetId: 'nep141:inactive.near',
      address: 'alice.near'
    }), /verification rejected/);
  } finally {
    store.close();
  }
});
