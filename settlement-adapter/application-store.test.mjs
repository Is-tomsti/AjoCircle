import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  assert.deepEqual(ctx.allowedOriginAssets, ['asset:usdc-base']);
  assert.deepEqual(ctx.refundAddresses, { 'asset:usdc-base': '0xregistered' });
  assert.deepEqual(ctx.maxInputAmounts, { 'asset:usdc-base': '5000000' });
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
