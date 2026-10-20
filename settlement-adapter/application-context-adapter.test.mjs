import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationContextResolvers } from './application-context-adapter.mjs';

const context = {
  circleId: 'circle-1',
  memberId: 'member-1',
  round: 3,
  circleStatus: 'ACTIVE',
  memberStatus: 'ACTIVE',
  roundStatus: 'OPEN',
  memberNearAccount: 'alice.near',
  requiredContributionAmount: '1000000000000000000000000',
  allowedOriginAssets: ['asset:usdc-base'],
  refundAddresses: { 'asset:usdc-base': '0xregistered' },
  maxInputAmounts: { 'asset:usdc-base': '5000000' },
  roundDeadlineMs: 1900000000000,
  internalDatabaseRowId: 'must-not-escape',
};

function setup(overrides = {}) {
  const { repository: repositoryOverrides = {}, ...resolverOverrides } = overrides;
  const calls = { principal: 0, membership: 0, context: 0 };
  const repository = {
    async findMembershipForPrincipal(input) {
      calls.membership++;
      assert.deepEqual(input, { principalId: 'auth-provider-user-7', circleId: 'circle-1' });
      return { circleId: 'circle-1', memberId: 'member-1', status: 'ACTIVE' };
    },
    async getMemberQuoteContext(input) {
      calls.context++;
      assert.deepEqual(input, { circleId: 'circle-1', memberId: 'member-1', round: 3 });
      return { ...context, ...input };
    },
    ...repositoryOverrides,
  };
  const resolvers = createApplicationContextResolvers({
    repository,
    getPrincipalId(principal) {
      calls.principal++;
      assert.equal(principal.subject, 'verified-subject');
      return 'auth-provider-user-7';
    },
    ...resolverOverrides,
  });
  return { resolvers, calls };
}

test('requires an authoritative repository and trusted principal ID extractor', () => {
  assert.throws(() => createApplicationContextResolvers(), /authoritative membership\/context repository/);
  assert.throws(() => createApplicationContextResolvers({
    repository: { findMembershipForPrincipal() {}, getMemberQuoteContext() {} },
  }), /principal ID extractor/);
});

test('resolves active membership using the authenticated principal and circle', async () => {
  const { resolvers, calls } = setup();
  const memberId = await resolvers.resolveMemberIdentity({
    principal: { subject: 'verified-subject' }, circleId: 'circle-1',
  });
  assert.equal(memberId, 'member-1');
  assert.deepEqual(calls, { principal: 1, membership: 1, context: 0 });
});

test('fails closed for missing principal, invalid subject, inactive or mismatched membership', async () => {
  const base = setup();
  assert.equal(await base.resolvers.resolveMemberIdentity({ principal: null, circleId: 'circle-1' }), null);
  assert.equal(await base.resolvers.resolveMemberIdentity({ principal: { subject: 'verified-subject' }, circleId: ' ' }), null);

  for (const membership of [
    null,
    { circleId: 'circle-1', memberId: 'member-1', status: 'SUSPENDED' },
    { circleId: 'other-circle', memberId: 'member-1', status: 'ACTIVE' },
    { circleId: 'circle-1', memberId: ' ', status: 'ACTIVE' },
  ]) {
    const { resolvers } = setup({ repository: {
      async findMembershipForPrincipal() { return membership; },
    } });
    assert.equal(await resolvers.resolveMemberIdentity({
      principal: { subject: 'verified-subject' }, circleId: 'circle-1',
    }), null);
  }

  const failing = setup({ repository: {
    async findMembershipForPrincipal() { throw new Error('database unavailable'); },
  } });
  assert.equal(await failing.resolvers.resolveMemberIdentity({
    principal: { subject: 'verified-subject' }, circleId: 'circle-1',
  }), null);
});

test('returns only whitelisted trusted context fields and defensive copies', async () => {
  const { resolvers } = setup();
  const result = await resolvers.resolveTrustedContext({ circleId: 'circle-1', memberId: 'member-1', round: 3 });
  assert.equal(result.circleStatus, 'ACTIVE');
  assert.equal(result.refundAddresses['asset:usdc-base'], '0xregistered');
  assert.equal(Object.hasOwn(result, 'internalDatabaseRowId'), false);
  result.allowedOriginAssets.push('asset:attacker');
  result.refundAddresses['asset:usdc-base'] = '0xattacker';
  assert.deepEqual(context.allowedOriginAssets, ['asset:usdc-base']);
  assert.equal(context.refundAddresses['asset:usdc-base'], '0xregistered');
});

test('fails closed when trusted context is missing, mismatched, incomplete, or unavailable', async () => {
  for (const returned of [
    null,
    { ...context, circleId: 'other-circle' },
    { ...context, memberId: 'other-member' },
    { ...context, round: 4 },
    { ...context, roundDeadlineMs: '1900000000000' },
    (() => { const { maxInputAmounts, ...partial } = context; return partial; })(),
    (() => { const { roundDeadlineMs, ...partial } = context; return partial; })(),
  ]) {
    const { resolvers } = setup({ repository: {
      async getMemberQuoteContext() { return returned; },
    } });
    assert.equal(await resolvers.resolveTrustedContext({
      circleId: 'circle-1', memberId: 'member-1', round: 3,
    }), null);
  }

  const failing = setup({ repository: {
    async getMemberQuoteContext() { throw new Error('database unavailable'); },
  } });
  assert.equal(await failing.resolvers.resolveTrustedContext({
    circleId: 'circle-1', memberId: 'member-1', round: 3,
  }), null);
});
