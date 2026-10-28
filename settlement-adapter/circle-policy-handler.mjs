import { verifyAjoCircleContract } from './near-contract-verification.mjs';

export const CIRCLE_CREATE_PATH = '/api/circle/create';
export const CIRCLE_CONTRACT_VERIFY_PATH = '/api/circle/verify-contract';
export const CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH = '/api/circle/schedule-parity/configure';
export const CIRCLE_POLICY_PREVIEW_PATH = '/api/circle/policy/preview';
export const CIRCLE_JOIN_PATH = '/api/circle/join';
export const CIRCLE_INVITATION_PATH = '/api/circle/invitations';
export const CIRCLE_INVITATION_REVOKE_PATH = '/api/circle/invitations/revoke';
export const CIRCLE_CYCLE_STATUS_PATH = '/api/circle/cycle/status';
export const CIRCLE_CYCLE_CONFIGURE_PATH = '/api/circle/cycle/configure';
export const CIRCLE_CYCLE_IMPORT_PATH = '/api/circle/cycle/import-verified';
export const CIRCLE_CYCLE_START_PATH = '/api/circle/cycle/start';
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    let serialized;
    try { serialized = JSON.stringify(request.body); } catch { throw new Error('INVALID_JSON'); }
    if (Buffer.byteLength(serialized ?? '', 'utf8') > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    return request.body;
  }
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(part, 'utf8');
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    raw += part;
  }
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}

function validId(value, max = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function normalizeCycleRounds(rounds, nowMs) {
  if (!Array.isArray(rounds) || rounds.length < 2 || rounds.length > 100
      || !Number.isSafeInteger(nowMs) || nowMs <= 0) return null;
  const nowNs = BigInt(nowMs) * 1000000n;
  let previousDeadlineNs = 0n;
  let contributionAmount;
  const normalized = [];
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    if (!round || typeof round !== 'object' || Array.isArray(round)
        || Object.keys(round).some(key => !['contributionAmount', 'deadlineMs', 'deadlineNs'].includes(key))
        || typeof round.contributionAmount !== 'string' || !/^[1-9][0-9]*$/.test(round.contributionAmount)) return null;
    if (index === 0) contributionAmount = round.contributionAmount;
    if (round.contributionAmount !== contributionAmount) return null;
    let deadlineNs = round.deadlineNs;
    if (deadlineNs === undefined) {
      if (!Number.isSafeInteger(round.deadlineMs) || round.deadlineMs <= nowMs) return null;
      deadlineNs = String(BigInt(round.deadlineMs) * 1000000n);
    }
    if (typeof deadlineNs !== 'string' || !/^[1-9][0-9]*$/.test(deadlineNs)) return null;
    const exactDeadlineNs = BigInt(deadlineNs);
    const deadlineMs = Number(exactDeadlineNs / 1000000n);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0
        || (round.deadlineMs !== undefined && round.deadlineMs !== deadlineMs)
        || exactDeadlineNs <= nowNs || exactDeadlineNs <= previousDeadlineNs) return null;
    previousDeadlineNs = exactDeadlineNs;
    normalized.push({ contributionAmount: round.contributionAmount, deadlineMs, deadlineNs });
  }
  return normalized;
}

/**
 * Authenticated policy preview/join/invitation handler. The repository is a
 * trusted server-side object; never expose its write methods to browser code.
 * This handler records consent and membership metadata only, not money movement.
 */
export function createCirclePolicyHandler({ store, authenticateRequest, clock = () => Date.now(), verifyContract = verifyAjoCircleContract } = {}) {
  if (!store || typeof store.getCirclePolicy !== 'function' || typeof store.joinCircleAfterPolicyAcceptance !== 'function') {
    throw new Error('A trusted circle policy store is required');
  }
  if (typeof authenticateRequest !== 'function') throw new Error('A trusted request authenticator is required');
  if (typeof clock !== 'function') throw new Error('clock must be a function');
  if (typeof verifyContract !== 'function') throw new Error('verifyContract must be a function');

  return async function circlePolicyHandler(request, response) {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { return sendJson(response, 400, { error: 'INVALID_REQUEST' }); }
    if (![CIRCLE_CREATE_PATH, CIRCLE_CONTRACT_VERIFY_PATH, CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, CIRCLE_POLICY_PREVIEW_PATH, CIRCLE_JOIN_PATH, CIRCLE_INVITATION_PATH, CIRCLE_INVITATION_REVOKE_PATH, CIRCLE_CYCLE_STATUS_PATH, CIRCLE_CYCLE_CONFIGURE_PATH, CIRCLE_CYCLE_IMPORT_PATH, CIRCLE_CYCLE_START_PATH].includes(pathname)) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let principal;
    try { principal = await authenticateRequest(request); } catch { principal = null; }
    if (!principal || !validId(principal.subject, 512)) return sendJson(response, 401, { error: 'UNAUTHENTICATED' });

    let body;
    try { body = await readJsonBody(request); }
    catch (error) {
      const tooLarge = error?.message === 'BODY_TOO_LARGE';
      return sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { error: 'INVALID_BODY' });

    try {
      if (pathname === CIRCLE_CREATE_PATH) {
        const allowed = ['contractId', 'mode', 'gracePeriodDays', 'shortfallPolicy'];
        if (Object.keys(body).some(key => !allowed.includes(key)) || !validId(body.contractId, 64)
            || body.contractId.length < 2 || !body.contractId.split('.').every(part => /^[a-z0-9_-]+$/.test(part))
            || !['PROTECTED_PUBLIC', 'PRIVATE_TRUSTED'].includes(body.mode)
            || !Number.isSafeInteger(body.gracePeriodDays) || body.gracePeriodDays < 1 || body.gracePeriodDays > 30
            || (body.shortfallPolicy !== undefined && !['WAIT_FOR_FULL_POT', 'ALLOW_PARTIAL_PAYOUT'].includes(body.shortfallPolicy))) {
          return sendJson(response, 400, { error: 'INVALID_CIRCLE_CREATE_REQUEST' });
        }
        const circle = store.createCircleForPrincipal({
          principalId: principal.subject, nearAccount: principal.subject, contractId: body.contractId.trim(),
          mode: body.mode, gracePeriodDays: body.gracePeriodDays, shortfallPolicy: body.shortfallPolicy,
        });
        return sendJson(response, 201, { circle: {
          circleId: circle.circleId, contractId: circle.contractId, creatorMemberId: circle.creatorMemberId,
          policy: circle.policy, contractBindingVerified: false, policyAcceptanceRequired: true,
        } });
      }

      if (pathname === CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH) {
        const accountPattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
        const validAccountList = value => Array.isArray(value) && value.length >= 2 && value.length <= 100
          && value.every(account => typeof account === 'string' && accountPattern.test(account))
          && new Set(value).size === value.length;
        if (Object.keys(body).some(key => !['circleId', 'members', 'payoutOrder', 'treasurerAgent'].includes(key))
            || !validId(body.circleId) || !validAccountList(body.members) || !validAccountList(body.payoutOrder)
            || typeof body.treasurerAgent !== 'string' || !accountPattern.test(body.treasurerAgent)) {
          return sendJson(response, 400, { error: 'INVALID_SCHEDULE_PARITY_CONFIGURATION' });
        }
        const circleId = body.circleId.trim();
        const member = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
        if (!member) return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
        const schedule = store.configureCircleContractSchedule({ circleId, creatorMemberId: member.memberId,
          members: body.members, payoutOrder: body.payoutOrder, treasurerAgent: body.treasurerAgent });
        return sendJson(response, 200, { schedule, quoteReady: false,
          note: 'Expected schedule configuration saved. Repeat read-only contract verification to compare it with on-chain evidence; quotes remain blocked until exact parity is proven.' });
      }

      if (pathname === CIRCLE_CONTRACT_VERIFY_PATH) {
        if (Object.keys(body).some(key => key !== 'circleId') || !validId(body.circleId)) {
          return sendJson(response, 400, { error: 'INVALID_CONTRACT_VERIFICATION_REQUEST' });
        }
        const circleId = body.circleId.trim();
        const member = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
        if (!member) return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
        const context = store.getCircleContractVerificationContext({ circleId, requestedByMemberId: member.memberId, allowActiveMember: true });
        const verification = await verifyContract({ contractId: context.contractId, expectedMode: context.mode });
        const binding = store.recordVerifiedContractBinding({ circleId, creatorMemberId: member.memberId, verification });
        return sendJson(response, 200, { binding, quoteReady: binding.quoteReady,
          note: binding.quoteReady ? 'Read-only verification and exact local/on-chain schedule parity passed.' : 'Read-only verification completed, but schedule parity is incomplete or mismatched; quote creation remains blocked.' });
      }

      if (pathname === CIRCLE_CYCLE_IMPORT_PATH) {
        if (Object.keys(body).some(key => key !== 'circleId') || !validId(body.circleId)) {
          return sendJson(response, 400, { error: 'INVALID_CYCLE_IMPORT_REQUEST' });
        }
        const circleId = body.circleId.trim();
        const member = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
        if (!member) return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
        const context = store.getCircleContractVerificationContext({ circleId, requestedByMemberId: member.memberId });
        const verification = await verifyContract({ contractId: context.contractId, expectedMode: context.mode });
        const cycle = store.importVerifiedContractCycle({
          circleId, creatorMemberId: member.memberId, verification, nowMs: clock(),
        });
        const binding = store.recordVerifiedContractBinding({
          circleId, creatorMemberId: member.memberId, verification,
        });
        return sendJson(response, 200, {
          imported: true, cycle, binding, quoteReady: binding.quoteReady,
          note: binding.quoteReady
            ? 'Existing on-chain cycle was reconciled locally and exact schedule parity passed.'
            : 'Existing on-chain cycle was reconciled locally from fresh read-only evidence. Quote creation remains blocked by remaining safety checks.',
        });
      }

      if (pathname === CIRCLE_CYCLE_CONFIGURE_PATH) {
        if (Object.keys(body).some(key => !['circleId', 'rounds'].includes(key)) || !validId(body.circleId)) {
          return sendJson(response, 400, { error: 'INVALID_CYCLE_CONFIGURATION' });
        }
        const rounds = normalizeCycleRounds(body.rounds, clock());
        if (!rounds) return sendJson(response, 400, { error: 'INVALID_CYCLE_CONFIGURATION' });
        const circleId = body.circleId.trim();
        const member = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
        if (!member) return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
        const cycle = store.configureCircleCycle({ circleId, createdByMemberId: member.memberId, rounds });
        return sendJson(response, 201, { cycle });
      }

      if (pathname === CIRCLE_CYCLE_STATUS_PATH || pathname === CIRCLE_CYCLE_START_PATH) {
        if (Object.keys(body).some(key => !['circleId'].includes(key)) || !validId(body.circleId)) {
          return sendJson(response, 400, { error: 'INVALID_CYCLE_REQUEST' });
        }
        const circleId = body.circleId.trim();
        const member = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
        if (!member) return sendJson(response, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
        if (pathname === CIRCLE_CYCLE_STATUS_PATH) {
          const cycle = store.getCircleCycleStatus({ circleId });
          return cycle ? sendJson(response, 200, { cycle: { ...cycle, canStart: cycle.status === 'DRAFT' && cycle.ready === true && cycle.createdByMemberId === member.memberId } }) : sendJson(response, 404, { error: 'CYCLE_NOT_CONFIGURED' });
        }
        const cycle = store.startCircleCycle({ circleId, requestedByMemberId: member.memberId, nowMs: clock() });
        return sendJson(response, 200, { cycle });
      }

      if (pathname === CIRCLE_POLICY_PREVIEW_PATH) {
        if (Object.keys(body).some(key => !['circleId', 'inviteToken'].includes(key)) || !validId(body.circleId)) {
          return sendJson(response, 400, { error: 'INVALID_POLICY_PREVIEW' });
        }
        const circleId = body.circleId.trim();
        const policy = store.getCirclePolicy({ circleId });
        if (!policy) return sendJson(response, 404, { error: 'CIRCLE_NOT_FOUND' });
        if (policy.mode === 'PRIVATE_TRUSTED') {
          const existingMember = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
          if (!existingMember) {
            if (!validId(body.inviteToken, 512)) return sendJson(response, 404, { error: 'INVITATION_INVALID' });
            const invite = store.getCircleInvitationContext({ circleId, token: body.inviteToken, nowMs: clock() });
            if (!invite) return sendJson(response, 404, { error: 'INVITATION_INVALID' });
          } else if (body.inviteToken !== undefined) {
            return sendJson(response, 400, { error: 'INVITATION_NOT_NEEDED' });
          }
        } else if (body.inviteToken !== undefined) {
          return sendJson(response, 400, { error: 'INVITATION_NOT_ALLOWED' });
        }
        return sendJson(response, 200, { policy: {
          circleId: policy.circleId, policyVersion: policy.policyVersion, mode: policy.mode,
          publiclyDiscoverable: policy.publiclyDiscoverable, invitationOnly: policy.invitationOnly,
          gracePeriodDays: policy.gracePeriodDays, shortfallPolicy: policy.shortfallPolicy,
          penaltyBps: policy.penaltyBps, distributionPolicy: policy.distributionPolicy,
          policyHash: policy.policyHash,
        } });
      }

      if (pathname === CIRCLE_JOIN_PATH) {
        if (Object.keys(body).some(key => !['circleId', 'policyVersion', 'accepted', 'inviteToken'].includes(key))
            || !validId(body.circleId) || !Number.isSafeInteger(body.policyVersion) || body.policyVersion < 1
            || body.accepted !== true || (body.inviteToken !== undefined && !validId(body.inviteToken, 512))) {
          return sendJson(response, 400, { error: 'INVALID_JOIN_REQUEST' });
        }
        const circleId = body.circleId.trim();
        const policy = store.getCirclePolicy({ circleId });
        if (!policy) return sendJson(response, 404, { error: 'CIRCLE_NOT_FOUND' });
        if (policy.policyVersion !== body.policyVersion) return sendJson(response, 409, { error: 'POLICY_VERSION_CHANGED', currentPolicyVersion: policy.policyVersion });
        if (policy.mode === 'PRIVATE_TRUSTED') {
          const existingMember = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
          if (!existingMember && (!validId(body.inviteToken, 512)
              || !store.getCircleInvitationContext({ circleId, token: body.inviteToken, nowMs: clock() }))) {
            return sendJson(response, 403, { error: 'INVITATION_INVALID' });
          }
          if (existingMember && body.inviteToken !== undefined) return sendJson(response, 400, { error: 'INVITATION_NOT_NEEDED' });
        } else if (body.inviteToken !== undefined) {
          return sendJson(response, 400, { error: 'INVITATION_NOT_ALLOWED' });
        }
        const member = store.ensureMemberForPrincipal({ principalId: principal.subject, nearAccount: principal.subject });
        store.recordCirclePolicyAcceptance({ circleId, policyVersion: policy.policyVersion, memberId: member.memberId, accepted: true });
        const membership = store.joinCircleAfterPolicyAcceptance({
          circleId, memberId: member.memberId,
          ...(body.inviteToken === undefined ? {} : { inviteToken: body.inviteToken }),
          nowMs: clock(),
        });
        return sendJson(response, 201, { membership, acceptedPolicyHash: policy.policyHash });
      }

      if (pathname === CIRCLE_INVITATION_REVOKE_PATH) {
        if (Object.keys(body).some(key => !['circleId', 'token'].includes(key)) || !validId(body.circleId) || !validId(body.token, 512)) {
          return sendJson(response, 400, { error: 'INVALID_INVITATION_REVOCATION' });
        }
        const member = store.ensureMemberForPrincipal({ principalId: principal.subject, nearAccount: principal.subject });
        store.revokeCircleInvitation({ circleId: body.circleId.trim(), createdByMemberId: member.memberId, token: body.token });
        return sendJson(response, 200, { revoked: true });
      }

      if (Object.keys(body).some(key => !['circleId', 'expiresInHours', 'maxUses'].includes(key))
          || !validId(body.circleId) || !Number.isSafeInteger(body.expiresInHours)
          || body.expiresInHours < 1 || body.expiresInHours > 720
          || (body.maxUses !== undefined && (!Number.isSafeInteger(body.maxUses) || body.maxUses < 1 || body.maxUses > 100))) {
        return sendJson(response, 400, { error: 'INVALID_INVITATION_REQUEST' });
      }
      const circleId = body.circleId.trim();
      const member = store.ensureMemberForPrincipal({ principalId: principal.subject, nearAccount: principal.subject });
      const nowMs = clock();
      const invitation = store.createCircleInvitation({
        circleId, createdByMemberId: member.memberId,
        expiresAtMs: nowMs + body.expiresInHours * 3_600_000,
        maxUses: body.maxUses ?? 1, nowMs,
      });
      return sendJson(response, 201, { invitation });
    } catch (error) {
      const message = String(error?.message ?? '');
      if (message.includes('only the circle creator')) {
        if (pathname === CIRCLE_CYCLE_IMPORT_PATH && typeof store.getCircleCreatorAccount === 'function') {
          try {
            const creator = store.getCircleCreatorAccount({ circleId: typeof body?.circleId === 'string' ? body.circleId.trim() : '' });
            return sendJson(response, 403, {
              error: 'CIRCLE_CREATOR_REQUIRED',
              creatorAccountId: creator.nearAccount,
              message: `Sign in with the circle creator wallet (${creator.nearAccount}) to import this existing on-chain cycle. The current wallet is not authorized for this creator-only action.`,
            });
          } catch { /* preserve the generic authorization response if creator details are unavailable */ }
        }
        return sendJson(response, 403, { error: 'CIRCLE_CREATOR_REQUIRED', message: 'Only the circle creator can perform this action.' });
      }
      if (pathname === CIRCLE_CONTRACT_VERIFY_PATH && message.includes('verification context not found')) return sendJson(response, 404, { error: 'CIRCLE_NOT_FOUND' });
      if (pathname === CIRCLE_CONTRACT_VERIFY_PATH) return sendJson(response, 409, { error: 'CONTRACT_VERIFICATION_FAILED', message });
      if (pathname === CIRCLE_CYCLE_IMPORT_PATH) return sendJson(response, 409, { error: 'CYCLE_IMPORT_REJECTED', message });
      if (pathname === CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH && message.includes('members must exactly match')) {
        return sendJson(response, 409, { error: 'SCHEDULE_MEMBERSHIP_MISMATCH', message: 'The expected member list must exactly match the circle’s active local memberships. No schedule configuration was saved; reconcile memberships before retrying.' });
      }
      if (message.includes('contract is already registered')) return sendJson(response, 409, { error: 'CONTRACT_ALREADY_REGISTERED' });
      if (message.includes('only an active member') || message.includes('invitations are only available')) {
        return sendJson(response, 403, { error: 'INVITATION_NOT_ALLOWED' });
      }
      if (message.includes('invitation is invalid')) return sendJson(response, 403, { error: 'INVITATION_INVALID' });
      if (message.includes('active invitation not found')) return sendJson(response, 403, { error: 'INVITATION_NOT_FOUND_OR_NOT_OWNED' });
      if (message.includes('cycle has not been provisioned')) return sendJson(response, 404, { error: 'CYCLE_NOT_CONFIGURED' });
      if (message.includes('only the cycle creator')) return sendJson(response, 403, { error: 'CYCLE_CREATOR_REQUIRED' });
      if (message.includes('cycle') || message.includes('every active member') || message.includes('every planned round') || message.includes('rounds must') || message.includes('all cycle rounds') || message.includes('active member count')) {
        return sendJson(response, 409, { error: 'CYCLE_NOT_READY', message });
      }
      if (message.includes('member does not exist') || message.includes('registered to a different principal')) {
        return sendJson(response, 403, { error: 'MEMBER_IDENTITY_REJECTED' });
      }
      return sendJson(response, 422, { error: 'CIRCLE_POLICY_REQUEST_REJECTED' });
    }
  };
}
