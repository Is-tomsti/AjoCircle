import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateCirclePolicy } from './circle-policy.mjs';
import { compareCircleSchedule } from './contract-schedule-parity.mjs';
import { APPROVED_AJOCIRCLE_TESTNET_SHA256S } from './near-contract-verification.mjs';

const AMOUNT_RE = /^[1-9][0-9]*$/;
const STATUSES = {
  circle: new Set(['ACTIVE', 'INACTIVE', 'COMPLETED']),
  member: new Set(['ACTIVE', 'SUSPENDED', 'LEFT']),
  round: new Set(['OPEN', 'CLOSED', 'COMPLETE']),
};

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' must be a non-empty string');
  return value.trim();
}
function amount(value, field) {
  if (typeof value !== 'string' || !AMOUNT_RE.test(value)) throw new Error(field + ' must be a positive integer base-unit string');
  return value;
}
function status(value, allowed, field) {
  if (!allowed.has(value)) throw new Error(field + ' has an unsupported status');
  return value;
}

/**
 * Persistent SQLite repository for server-managed circle/member/round metadata.
 * Authentication is external: principalId must be extracted from a verified
 * authentication principal before calling findMembershipForPrincipal().
 *
 * Provisioning methods are server-side application operations, NOT public API
 * handlers. Never expose this object or its write methods to browser clients.
 */
export class ApplicationStore {
  constructor({ path = ':memory:', clock = () => new Date().toISOString() } = {}) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_circles (
        circle_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','INACTIVE','COMPLETED')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_members (
        member_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL UNIQUE,
        near_account TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_circle_memberships (
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        member_id TEXT NOT NULL REFERENCES app_members(member_id),
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUSPENDED','LEFT')),
        PRIMARY KEY(circle_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS app_circle_creators (
        circle_id TEXT PRIMARY KEY REFERENCES app_circles(circle_id),
        member_id TEXT NOT NULL REFERENCES app_members(member_id)
      );
      CREATE TABLE IF NOT EXISTS app_circle_contract_schedule_configs (
        circle_id TEXT PRIMARY KEY REFERENCES app_circles(circle_id),
        creator_member_id TEXT NOT NULL REFERENCES app_members(member_id),
        members_json TEXT NOT NULL,
        payout_order_json TEXT NOT NULL,
        treasurer_agent TEXT NOT NULL,
        configured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_verified_contract_bindings (
        circle_id TEXT PRIMARY KEY REFERENCES app_circles(circle_id),
        contract_id TEXT NOT NULL,
        network TEXT NOT NULL CHECK(network='testnet'),
        code_sha256 TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('ProtectedPublic','Private')),
        current_round INTEGER NOT NULL CHECK(current_round >= 0),
        round_deadline TEXT NOT NULL,
        contribution_count INTEGER NOT NULL CHECK(contribution_count >= 0),
        current_recipient TEXT NOT NULL,
        circle_completed INTEGER NOT NULL CHECK(circle_completed IN (0,1)),
        payout_pending INTEGER NOT NULL CHECK(payout_pending IN (0,1)),
        payout_complete INTEGER NOT NULL CHECK(payout_complete IN (0,1)),
        required_protection TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        quote_ready INTEGER NOT NULL DEFAULT 0 CHECK(quote_ready IN (0,1)),
        quote_readiness_reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_rounds (
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        round_number INTEGER NOT NULL CHECK(round_number >= 0),
        status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED','COMPLETE')),
        contribution_amount TEXT NOT NULL CHECK(length(contribution_amount) > 0 AND contribution_amount NOT GLOB '*[^0-9]*' AND contribution_amount != '0'),
        deadline_ms INTEGER NOT NULL CHECK(deadline_ms > 0),
        deadline_ns TEXT NOT NULL CHECK(length(deadline_ns) > 0 AND deadline_ns NOT GLOB '*[^0-9]*' AND deadline_ns != '0'),
        PRIMARY KEY(circle_id, round_number)
      );
      CREATE TABLE IF NOT EXISTS app_circle_cycles (
        circle_id TEXT PRIMARY KEY REFERENCES app_circles(circle_id),
        created_by_member_id TEXT NOT NULL REFERENCES app_members(member_id),
        policy_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        planned_rounds INTEGER NOT NULL CHECK(planned_rounds BETWEEN 2 AND 100),
        status TEXT NOT NULL CHECK(status IN ('DRAFT','STARTED','COMPLETED')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        FOREIGN KEY(circle_id, policy_version) REFERENCES app_circle_policies(circle_id, policy_version)
      );
      CREATE TABLE IF NOT EXISTS app_circle_assets (
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        asset_id TEXT NOT NULL,
        max_input_amount TEXT NOT NULL CHECK(length(max_input_amount) > 0 AND max_input_amount NOT GLOB '*[^0-9]*' AND max_input_amount != '0'),
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        PRIMARY KEY(circle_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS app_circle_policies (
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
        mode TEXT NOT NULL CHECK(mode IN ('PROTECTED_PUBLIC','PRIVATE_TRUSTED')),
        publicly_discoverable INTEGER NOT NULL CHECK(publicly_discoverable IN (0,1)),
        grace_period_days INTEGER NOT NULL CHECK(grace_period_days BETWEEN 1 AND 30),
        shortfall_policy TEXT NOT NULL CHECK(shortfall_policy IN ('WAIT_FOR_FULL_POT','ALLOW_PARTIAL_PAYOUT')),
        penalty_bps INTEGER NOT NULL CHECK(penalty_bps BETWEEN 0 AND 1000),
        distribution_policy TEXT NOT NULL CHECK(distribution_policy IN ('PROPORTIONAL_VERIFIED_CONTRIBUTIONS','ROTATING_ROUND_RECIPIENT')),
        policy_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(circle_id, policy_version)
      );
      CREATE TABLE IF NOT EXISTS app_circle_policy_acceptances (
        circle_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        member_id TEXT NOT NULL REFERENCES app_members(member_id),
        policy_hash TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY(circle_id, policy_version, member_id),
        FOREIGN KEY(circle_id, policy_version) REFERENCES app_circle_policies(circle_id, policy_version)
      );
      CREATE TABLE IF NOT EXISTS app_circle_invitations (
        token_hash TEXT PRIMARY KEY,
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        created_by_member_id TEXT NOT NULL REFERENCES app_members(member_id),
        expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > 0),
        max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_circle_invitation_lookup ON app_circle_invitations(circle_id, revoked, expires_at_ms);
      CREATE TABLE IF NOT EXISTS app_member_refund_addresses (
        member_id TEXT NOT NULL REFERENCES app_members(member_id),
        asset_id TEXT NOT NULL,
        address TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED','VERIFIED')),
        verified_at TEXT,
        verification_method TEXT,
        PRIMARY KEY(member_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS app_membership_by_member ON app_circle_memberships(member_id);
      CREATE INDEX IF NOT EXISTS app_round_lookup ON app_rounds(circle_id, round_number, status);
    `);
    const refundAddressColumns = new Set(this.db.prepare('PRAGMA table_info(app_member_refund_addresses)').all().map(column => column.name));
    const addedRefundVerificationStatus = !refundAddressColumns.has('verification_status');
    if (addedRefundVerificationStatus) this.db.exec("ALTER TABLE app_member_refund_addresses ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'");
    if (!refundAddressColumns.has('verified_at')) this.db.exec('ALTER TABLE app_member_refund_addresses ADD COLUMN verified_at TEXT');
    if (!refundAddressColumns.has('verification_method')) this.db.exec('ALTER TABLE app_member_refund_addresses ADD COLUMN verification_method TEXT');
    // Legacy rows are not proof of control of the origin-chain wallet; reset only during migration.
    if (addedRefundVerificationStatus) this.db.exec("UPDATE app_member_refund_addresses SET verification_status='UNVERIFIED', verified_at=NULL, verification_method=NULL");

    const roundColumns = new Set(this.db.prepare('PRAGMA table_info(app_rounds)').all().map(column => column.name));
    if (!roundColumns.has('deadline_ns')) {
      this.db.exec('ALTER TABLE app_rounds ADD COLUMN deadline_ns TEXT');
      this.db.exec("UPDATE app_rounds SET deadline_ns=CAST(deadline_ms AS TEXT)||'000000' WHERE deadline_ns IS NULL");
    }
    const bindingColumns = new Set(this.db.prepare('PRAGMA table_info(app_verified_contract_bindings)').all().map(column => column.name));
    if (!bindingColumns.has('verification_json')) this.db.exec("ALTER TABLE app_verified_contract_bindings ADD COLUMN verification_json TEXT NOT NULL DEFAULT '{}'");
    if (!bindingColumns.has('parity_mismatches_json')) this.db.exec("ALTER TABLE app_verified_contract_bindings ADD COLUMN parity_mismatches_json TEXT NOT NULL DEFAULT '[]'");
    const policyColumns = new Set(this.db.prepare('PRAGMA table_info(app_circle_policies)').all().map(column => column.name));
    // Legacy policies remain NULL and cannot start a cycle until members accept a newly published version.
    if (!policyColumns.has('distribution_policy')) this.db.exec('ALTER TABLE app_circle_policies ADD COLUMN distribution_policy TEXT');
  }

  // These writes belong to trusted server-side circle setup/admin workflows.
  createCircleForPrincipal({ principalId, nearAccount, contractId, mode, gracePeriodDays, shortfallPolicy = 'WAIT_FOR_FULL_POT' }) {
    const contract = text(contractId, 'contractId');
    if (contract.length < 2 || contract.length > 64 || !contract.split('.').every(part => /^[a-z0-9_-]+$/.test(part))) {
      throw new Error('contractId must be a valid NEAR account ID');
    }
    const circleId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT circle_id FROM app_circles WHERE contract_id=?').get(contract);
      if (existing) throw new Error('contract is already registered to a circle');
      const member = this.ensureMemberForPrincipal({ principalId, nearAccount });
      this.upsertCircle({ circleId, contractId: contract, status: 'ACTIVE' });
      const policy = this.createCirclePolicy({ circleId, mode, gracePeriodDays, shortfallPolicy });
      this.setMembership({ circleId, memberId: member.memberId, status: 'ACTIVE' });
      this.db.prepare('INSERT INTO app_circle_creators(circle_id,member_id) VALUES(?,?)').run(circleId, member.memberId);
      this.db.exec('COMMIT');
      return Object.freeze({ circleId, contractId: contract, creatorMemberId: member.memberId, policy });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  getCircleCreatorAccount({ circleId } = {}) {
    const circle = text(circleId, 'circleId');
    const row = this.db.prepare(`SELECT owner.member_id, m.near_account
      FROM app_circle_creators owner JOIN app_members m ON m.member_id=owner.member_id
      WHERE owner.circle_id=?`).get(circle);
    if (!row) throw new Error('circle verification context not found');
    return Object.freeze({ memberId: row.member_id, nearAccount: row.near_account });
  }

  getCircleContractVerificationContext({ circleId, requestedByMemberId, allowActiveMember = false }) {
    const circle = text(circleId, 'circleId');
    const requester = text(requestedByMemberId, 'requestedByMemberId');
    const row = this.db.prepare(`SELECT c.contract_id, p.mode, owner.member_id AS creator_member_id
      FROM app_circles c JOIN app_circle_policies p ON p.circle_id=c.circle_id
      JOIN app_circle_creators owner ON owner.circle_id=c.circle_id
      WHERE c.circle_id=? AND p.policy_version=(SELECT MAX(policy_version) FROM app_circle_policies WHERE circle_id=c.circle_id)`)
      .get(circle);
    if (!row) throw new Error('circle verification context not found');
    if (row.creator_member_id !== requester) {
      const activeMembership = allowActiveMember && this.db.prepare("SELECT 1 FROM app_circle_memberships cm JOIN app_circles c ON c.circle_id=cm.circle_id WHERE cm.circle_id=? AND cm.member_id=? AND cm.status='ACTIVE' AND c.status='ACTIVE'").get(circle, requester);
      if (!activeMembership) throw new Error('only the circle creator or an active circle member may verify the contract');
    }
    return Object.freeze({ circleId: circle, contractId: row.contract_id, mode: row.mode, creatorMemberId: row.creator_member_id });
  }

  configureCircleContractSchedule({ circleId, creatorMemberId, members, payoutOrder, treasurerAgent }) {
    const circle = text(circleId, 'circleId');
    const creator = text(creatorMemberId, 'creatorMemberId');
    const accountPattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
    const validateList = (list, field) => {
      if (!Array.isArray(list) || list.length < 2 || list.length > 100
          || list.some(account => typeof account !== 'string' || !accountPattern.test(account))
          || new Set(list).size !== list.length) throw new Error(`${field} must contain unique valid NEAR account IDs`);
      return [...list];
    };
    const orderedMembers = validateList(members, 'members');
    const orderedPayout = validateList(payoutOrder, 'payoutOrder');
    if (typeof treasurerAgent !== 'string' || !accountPattern.test(treasurerAgent)) throw new Error('treasurerAgent must be a valid NEAR account ID');
    if (orderedPayout.length !== orderedMembers.length || orderedPayout.some(account => !orderedMembers.includes(account))) {
      throw new Error('payoutOrder must be a permutation of members');
    }
    const context = this.getCircleContractVerificationContext({ circleId: circle, requestedByMemberId: creator });
    const active = this.db.prepare(`SELECT m.near_account, cm.member_id FROM app_circle_memberships cm
      JOIN app_members m ON m.member_id=cm.member_id WHERE cm.circle_id=? AND cm.status='ACTIVE'`).all(circle);
    const creatorRow = this.db.prepare('SELECT member_id FROM app_circle_creators WHERE circle_id=?').get(circle);
    // The circle creator is also stored as an active local membership for admin
    // authorization. They are not automatically a contract participant: include
    // them only when their NEAR account is explicitly in the contract member list.
    const activeParticipants = active.filter(row => row.member_id !== creatorRow?.member_id || orderedMembers.includes(row.near_account));
    if (activeParticipants.length !== orderedMembers.length || activeParticipants.some(row => !orderedMembers.includes(row.near_account))) {
      throw new Error('members must exactly match active participant memberships (creator/admin is excluded unless explicitly listed)');
    }
    const cycle = this.db.prepare('SELECT status FROM app_circle_cycles WHERE circle_id=?').get(circle);
    if (cycle?.status === 'STARTED') throw new Error('contract schedule configuration cannot change after the cycle starts');
    this.db.prepare(`INSERT INTO app_circle_contract_schedule_configs
      (circle_id,creator_member_id,members_json,payout_order_json,treasurer_agent,configured_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(circle_id) DO UPDATE SET creator_member_id=excluded.creator_member_id,
      members_json=excluded.members_json,payout_order_json=excluded.payout_order_json,
      treasurer_agent=excluded.treasurer_agent,configured_at=excluded.configured_at`)
      .run(context.circleId, creator, JSON.stringify(orderedMembers), JSON.stringify(orderedPayout), treasurerAgent, this.clock());
    const binding = this.getVerifiedContractBinding({ circleId: circle });
    if (binding) this.db.prepare("UPDATE app_verified_contract_bindings SET quote_ready=0,parity_mismatches_json='[]',quote_readiness_reason=? WHERE circle_id=?")
      .run('Local schedule configuration changed; read-only contract verification must be repeated. Quote creation remains blocked.', circle);
    return Object.freeze({ circleId: circle, members: Object.freeze(orderedMembers), payoutOrder: Object.freeze(orderedPayout), treasurerAgent, configuredAt: this.clock() });
  }

  getCircleScheduleParityContext({ circleId } = {}) {
    const circle = text(circleId, 'circleId');
    const config = this.db.prepare('SELECT * FROM app_circle_contract_schedule_configs WHERE circle_id=?').get(circle);
    const cycle = this.db.prepare('SELECT * FROM app_circle_cycles WHERE circle_id=?').get(circle);
    const rounds = this.db.prepare('SELECT round_number,status,contribution_amount,deadline_ms,deadline_ns FROM app_rounds WHERE circle_id=? ORDER BY round_number').all(circle);
    if (!config || !cycle || rounds.length !== cycle.planned_rounds || rounds.length < 2) {
      return Object.freeze({ ready: false, reason: 'Local contract schedule configuration or complete cycle schedule is missing.' });
    }
    const members = JSON.parse(config.members_json);
    const payoutOrder = JSON.parse(config.payout_order_json);
    const activeRows = this.db.prepare(`SELECT m.near_account, cm.member_id FROM app_circle_memberships cm
      JOIN app_members m ON m.member_id=cm.member_id WHERE cm.circle_id=? AND cm.status='ACTIVE'`).all(circle);
    const creatorRow = this.db.prepare('SELECT member_id FROM app_circle_creators WHERE circle_id=?').get(circle);
    const activeMembers = activeRows.filter(row => row.member_id !== creatorRow?.member_id || members.includes(row.near_account)).map(row => row.near_account);
    const activeMembersMatch = activeMembers.length === members.length && activeMembers.every(account => members.includes(account));
    const currentRound = rounds.findIndex(round => round.status !== 'COMPLETE');
    const effectiveRound = currentRound === -1 ? rounds.length : currentRound;
    const firstContribution = rounds[0]?.contribution_amount;
    const localRounds = rounds.map(round => ({ round: round.round_number, contributionAmount: round.contribution_amount, deadlineMs: round.deadline_ms, deadlineNs: round.deadline_ns }));
    const ready = activeMembersMatch && cycle.status === 'STARTED' && rounds.every((round, index) => round.round_number === index && round.status === (index < effectiveRound ? 'COMPLETE' : 'OPEN'));
    return Object.freeze({
      ready,
      reason: ready ? '' : !activeMembersMatch ? 'Active memberships changed after the expected contract member order was configured.' : cycle.status === 'COMPLETED' ? 'Local cycle is completed; quote creation is blocked for this cycle.' : 'Cycle must be started with a complete, sequential round lifecycle before schedule parity can enable quotes.',
      local: Object.freeze({ contractId: this.db.prepare('SELECT contract_id FROM app_circles WHERE circle_id=?').get(circle)?.contract_id,
        mode: this.db.prepare('SELECT mode FROM app_circle_policies WHERE circle_id=? ORDER BY policy_version DESC LIMIT 1').get(circle)?.mode,
        members, payoutOrder, treasurerAgent: config.treasurer_agent, currentRound: effectiveRound,
        roundDeadlineMs: localRounds[effectiveRound]?.deadlineMs ?? null,
        roundDeadlineNs: localRounds[effectiveRound]?.deadlineNs ?? null,
        contributionAmount: firstContribution, rounds: Object.freeze(localRounds) }),
    });
  }

  importVerifiedContractCycle({ circleId, creatorMemberId, verification, nowMs = Date.now() }) {
    const creator = text(creatorMemberId, 'creatorMemberId');
    const context = this.getCircleContractVerificationContext({ circleId, requestedByMemberId: creator });
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('nowMs must be a positive safe integer');
    if (!verification || verification.verified !== true || verification.network !== 'testnet'
        || verification.contractId !== context.contractId) throw new Error('fresh verified testnet contract evidence is required');
    const expectedMode = context.mode === 'PROTECTED_PUBLIC' ? 'ProtectedPublic' : 'Private';
    if (verification.mode !== expectedMode) throw new Error('verified contract mode does not match the circle policy');
    if (typeof verification.codeSha256 !== 'string'
        || !APPROVED_AJOCIRCLE_TESTNET_SHA256S.includes(verification.codeSha256.toLowerCase())) {
      throw new Error('verified contract hash is not approved');
    }
    if (verification.circleCompleted !== false || verification.payoutPending !== false || verification.payoutComplete !== false) {
      throw new Error('cannot import a completed or payout-pending contract lifecycle');
    }
    if (!Number.isSafeInteger(verification.currentRound) || verification.currentRound < 0
        || !Array.isArray(verification.rounds) || verification.rounds.length < 2
        || verification.currentRound >= verification.rounds.length
        || !Array.isArray(verification.members) || !Array.isArray(verification.payoutOrder)
        || typeof verification.contributionAmount !== 'string' || !AMOUNT_RE.test(verification.contributionAmount)
        || typeof verification.treasurerAgent !== 'string') {
      throw new Error('verified contract has an invalid or incomplete cycle schedule');
    }
    const config = this.db.prepare('SELECT * FROM app_circle_contract_schedule_configs WHERE circle_id=?').get(context.circleId);
    if (!config || JSON.stringify(JSON.parse(config.members_json)) !== JSON.stringify(verification.members)
        || JSON.stringify(JSON.parse(config.payout_order_json)) !== JSON.stringify(verification.payoutOrder)
        || config.treasurer_agent !== verification.treasurerAgent) {
      throw new Error('saved local schedule expectations do not exactly match verified contract configuration');
    }
    const activeRows = this.db.prepare(`SELECT m.near_account, cm.member_id FROM app_circle_memberships cm
      JOIN app_members m ON m.member_id=cm.member_id WHERE cm.circle_id=? AND cm.status='ACTIVE'`).all(context.circleId);
    const owner = this.db.prepare('SELECT member_id FROM app_circle_creators WHERE circle_id=?').get(context.circleId);
    const activeParticipants = activeRows.filter(row => row.member_id !== owner?.member_id || verification.members.includes(row.near_account));
    if (activeParticipants.length !== verification.members.length
        || activeParticipants.some(row => !verification.members.includes(row.near_account))) {
      throw new Error('active local memberships do not match verified on-chain participants');
    }
    const policy = this.getCirclePolicy({ circleId: context.circleId });
    if (!policy) throw new Error('circle policy is missing');
    for (const participant of activeParticipants) {
      if (!this.hasAcceptedCirclePolicy({ circleId: context.circleId, policyVersion: policy.policyVersion, memberId: participant.member_id })) {
        throw new Error('every active contract participant must accept the current policy before importing the cycle');
      }
    }
    let previousDeadlineNs = 0n;
    const normalizedRounds = verification.rounds.map((round, index) => {
      if (!round || round.round !== index || round.contributionAmount !== verification.contributionAmount
          || typeof round.deadlineNs !== 'string' || !/^[1-9][0-9]*$/.test(round.deadlineNs)) {
        throw new Error('verified contract returned an invalid full round schedule');
      }
      const deadlineNs = BigInt(round.deadlineNs);
      if (deadlineNs <= previousDeadlineNs) throw new Error('verified round deadlines must be strictly increasing');
      previousDeadlineNs = deadlineNs;
      const deadlineMs = Number(deadlineNs / 1000000n);
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('verified round deadline is outside the supported range');
      return { round: index, deadlineNs: round.deadlineNs, deadlineMs,
        status: index < verification.currentRound ? 'COMPLETE' : 'OPEN' };
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM app_circle_cycles WHERE circle_id=?').get(context.circleId);
      if (existing && (existing.created_by_member_id !== creator || existing.status === 'COMPLETED')) {
        throw new Error('existing local cycle cannot be safely reconciled with verified contract state');
      }
      if (!existing) {
        this.db.prepare(`INSERT INTO app_circle_cycles
          (circle_id,created_by_member_id,policy_version,policy_hash,planned_rounds,status,created_at,started_at)
          VALUES(?,?,?,?,?,'STARTED',?,?)`)
          .run(context.circleId, creator, policy.policyVersion, policy.policyHash, normalizedRounds.length,
            new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
      } else {
        if (existing.policy_version !== policy.policyVersion || existing.policy_hash !== policy.policyHash
            || existing.planned_rounds !== normalizedRounds.length) {
          throw new Error('existing local cycle policy or planned round count differs from the verified contract');
        }
        this.db.prepare(`UPDATE app_circle_cycles SET status='STARTED',started_at=COALESCE(started_at,?)
          WHERE circle_id=?`).run(new Date(nowMs).toISOString(), context.circleId);
      }
      for (const round of normalizedRounds) {
        this.db.prepare(`INSERT INTO app_rounds(circle_id,round_number,status,contribution_amount,deadline_ms,deadline_ns)
          VALUES(?,?,?,?,?,?) ON CONFLICT(circle_id,round_number) DO UPDATE SET
          status=excluded.status,contribution_amount=excluded.contribution_amount,
          deadline_ms=excluded.deadline_ms,deadline_ns=excluded.deadline_ns`)
          .run(context.circleId, round.round, round.status, verification.contributionAmount, round.deadlineMs, round.deadlineNs);
      }
      this.db.exec('COMMIT');
      return this.getCircleCycleStatus({ circleId: context.circleId });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  recordVerifiedContractBinding({ circleId, creatorMemberId, verification }) {
    const context = this.getCircleContractVerificationContext({ circleId, requestedByMemberId: creatorMemberId, allowActiveMember: true });
    if (!verification || verification.verified !== true || verification.network !== 'testnet') throw new Error('verification result is not trusted testnet evidence');
    if (verification.contractId !== context.contractId) throw new Error('verified contract ID does not match the registered circle');
    const expectedMode = context.mode === 'PROTECTED_PUBLIC' ? 'ProtectedPublic' : 'Private';
    if (verification.mode !== expectedMode) throw new Error('verified contract mode does not match the circle policy');
    if (typeof verification.codeSha256 !== 'string' || !APPROVED_AJOCIRCLE_TESTNET_SHA256S.includes(verification.codeSha256.toLowerCase())) throw new Error('verified contract hash is not approved');
    const fields = ['currentRound', 'contributionCount'];
    for (const field of fields) if (!Number.isSafeInteger(verification[field]) || verification[field] < 0) throw new Error(`verification ${field} is invalid`);
    for (const field of ['roundDeadline', 'currentRecipient', 'requiredProtection', 'verifiedAt', 'quoteReadinessReason']) {
      if (typeof verification[field] !== 'string' || !verification[field]) throw new Error(`verification ${field} is invalid`);
    }
    for (const field of ['circleCompleted', 'payoutPending', 'payoutComplete']) if (typeof verification[field] !== 'boolean') throw new Error(`verification ${field} is invalid`);
    const parityContext = this.getCircleScheduleParityContext({ circleId: context.circleId });
    const onChain = { ...verification, network: verification.network };
    // Evaluate on-chain lifecycle safety even when the local cycle is still a draft.
    // The local cycle-start gate remains independently mandatory for quote readiness.
    const parity = parityContext.local
      ? compareCircleSchedule({ local: parityContext.local, onChain })
      : Object.freeze({
        matches: false, scheduleMatches: false, parityMatches: false, quoteReady: false,
        lifecycleEligible: false, lifecycleBlockers: Object.freeze([]),
        mismatches: Object.freeze([]), parityMismatches: Object.freeze([]),
      });
    const deadlineMs = Date.parse(verification.verifiedAt);
    const currentDeadlineExpired = Number.isFinite(deadlineMs)
      && BigInt(verification.roundDeadline) <= BigInt(deadlineMs) * 1000000n;
    const localCycleStatus = this.db.prepare('SELECT status FROM app_circle_cycles WHERE circle_id=?')
      .get(context.circleId)?.status ?? null;
    const terminalLifecycleMatches = localCycleStatus === 'COMPLETED'
      && verification.circleCompleted === true
      && verification.payoutComplete === true
      && verification.payoutPending === false;
    const terminalParityMismatches = terminalLifecycleMatches
      ? parity.mismatches.filter(reason => reason !== 'current round differs'
        && reason !== 'contract lifecycle is not eligible for a new quote')
      : parity.mismatches;
    const blockers = terminalLifecycleMatches
      ? ['Local cycle is completed; quote creation is blocked for this cycle.',
        'On-chain circle and payout are complete; quote creation is permanently blocked for this cycle.']
      : [...new Set([
        ...(parityContext.ready ? [] : [parityContext.reason || 'local schedule is not ready']),
        ...terminalParityMismatches,
        ...(currentDeadlineExpired ? ['current on-chain round deadline has expired; quote creation remains blocked until safe deadline recovery and fresh verification'] : []),
      ])];
    const quoteReady = !terminalLifecycleMatches && parityContext.ready && parity.quoteReady === true && !currentDeadlineExpired;
    const readinessReason = quoteReady ? 'Exact local/on-chain schedule parity verified on testnet.'
      : `Quote creation remains blocked: ${blockers.join('; ') || 'local schedule is not ready'}`;
    this.db.prepare(`INSERT INTO app_verified_contract_bindings
      (circle_id,contract_id,network,code_sha256,mode,current_round,round_deadline,contribution_count,current_recipient,
       circle_completed,payout_pending,payout_complete,required_protection,verified_at,quote_ready,quote_readiness_reason,verification_json,parity_mismatches_json)
      VALUES(?,?,'testnet',?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?)
      ON CONFLICT(circle_id) DO UPDATE SET contract_id=excluded.contract_id,network=excluded.network,
       code_sha256=excluded.code_sha256,mode=excluded.mode,current_round=excluded.current_round,
       round_deadline=excluded.round_deadline,contribution_count=excluded.contribution_count,
       current_recipient=excluded.current_recipient,circle_completed=excluded.circle_completed,
       payout_pending=excluded.payout_pending,payout_complete=excluded.payout_complete,
       required_protection=excluded.required_protection,verified_at=excluded.verified_at,
       quote_ready=excluded.quote_ready,quote_readiness_reason=excluded.quote_readiness_reason,
       verification_json=excluded.verification_json,parity_mismatches_json=excluded.parity_mismatches_json`)
      .run(context.circleId, context.contractId, verification.codeSha256, verification.mode, verification.currentRound,
        verification.roundDeadline, verification.contributionCount, verification.currentRecipient,
        Number(verification.circleCompleted), Number(verification.payoutPending), Number(verification.payoutComplete),
        verification.requiredProtection, verification.verifiedAt, Number(quoteReady), readinessReason,
        JSON.stringify(verification), JSON.stringify(blockers));
    return this.getVerifiedContractBinding({ circleId: context.circleId });
  }

  invalidateQuoteReadiness({ circleId, reason } = {}) {
    const circle = text(circleId, 'circleId');
    const note = text(reason, 'reason');
    const result = this.db.prepare(`UPDATE app_verified_contract_bindings
      SET quote_ready=0, quote_readiness_reason=?, parity_mismatches_json=?
      WHERE circle_id=?`).run(note, JSON.stringify([note]), circle);
    return result.changes === 1;
  }

  getVerifiedContractBinding({ circleId } = {}) {
    const circle = text(circleId, 'circleId');
    const row = this.db.prepare('SELECT * FROM app_verified_contract_bindings WHERE circle_id=?').get(circle);
    if (!row) return null;
    const verification = JSON.parse(row.verification_json || '{}');
    const parityContext = this.getCircleScheduleParityContext({ circleId: circle });
    const onChain = { ...verification, network: row.network };
    const parity = parityContext.local
      ? compareCircleSchedule({ local: parityContext.local, onChain })
      : Object.freeze({
        parityMatches: false, lifecycleEligible: false,
        lifecycleBlockers: Object.freeze([]), parityMismatches: Object.freeze(['local schedule context is missing']),
      });
    const localCycleStatus = this.db.prepare('SELECT status FROM app_circle_cycles WHERE circle_id=?')
      .get(circle)?.status ?? null;
    const terminalLifecycleMatches = localCycleStatus === 'COMPLETED'
      && Boolean(row.circle_completed) && Boolean(row.payout_complete) && !Boolean(row.payout_pending);
    // A completed cycle naturally has a different current-round index; report that
    // separately from structural schedule parity while keeping quote readiness blocked.
    const scheduleParityMismatches = terminalLifecycleMatches
      ? parity.parityMismatches.filter(reason => reason !== 'current round differs')
      : parity.parityMismatches;
    const lifecycleBlockers = [
      ...parity.lifecycleBlockers,
      ...(localCycleStatus === 'COMPLETED'
        ? ['Local cycle is completed; quote creation is blocked for this cycle.'] : []),
    ];
    return Object.freeze({
      circleId: row.circle_id, contractId: row.contract_id, network: row.network, codeSha256: row.code_sha256,
      mode: row.mode, currentRound: row.current_round, roundDeadline: row.round_deadline,
      contributionCount: row.contribution_count, currentRecipient: row.current_recipient,
      circleCompleted: Boolean(row.circle_completed), payoutPending: Boolean(row.payout_pending),
      payoutComplete: Boolean(row.payout_complete), requiredProtection: row.required_protection,
      verifiedAt: row.verified_at, quoteReady: Boolean(row.quote_ready), quoteReadinessReason: row.quote_readiness_reason,
      verification, parityMismatches: JSON.parse(row.parity_mismatches_json || '[]'),
      scheduleParityMatches: scheduleParityMismatches.length === 0,
      scheduleParityMismatches: Object.freeze([...scheduleParityMismatches]),
      lifecycleEligible: lifecycleBlockers.length === 0,
      lifecycleBlockers: Object.freeze([...new Set(lifecycleBlockers)]),
    });
  }

  upsertCircle({ circleId, contractId, status: circleStatus = 'ACTIVE' }) {
    const id = text(circleId, 'circleId');
    const contract = text(contractId, 'contractId');
    const state = status(circleStatus, STATUSES.circle, 'circleStatus');
    this.db.prepare(`INSERT INTO app_circles(circle_id,contract_id,status,created_at)
      VALUES(?,?,?,?) ON CONFLICT(circle_id) DO UPDATE SET contract_id=excluded.contract_id,status=excluded.status`)
      .run(id, contract, state, this.clock());
  }

  ensureMemberForPrincipal({ principalId, nearAccount }) {
    const principal = text(principalId, 'principalId');
    const account = text(nearAccount, 'nearAccount');
    const byPrincipal = this.db.prepare('SELECT member_id, principal_id, near_account, created_at FROM app_members WHERE principal_id=?').get(principal);
    if (byPrincipal) {
      if (byPrincipal.near_account !== account) throw new Error('authenticated principal does not match the registered NEAR account');
      return Object.freeze({ memberId: byPrincipal.member_id, principalId: byPrincipal.principal_id, nearAccount: byPrincipal.near_account, createdAt: byPrincipal.created_at });
    }
    const byAccount = this.db.prepare('SELECT member_id, principal_id, near_account, created_at FROM app_members WHERE near_account=?').get(account);
    if (byAccount) throw new Error('NEAR account is already registered to a different principal');
    const memberId = randomUUID();
    const createdAt = this.clock();
    this.db.prepare('INSERT INTO app_members(member_id,principal_id,near_account,created_at) VALUES(?,?,?,?)')
      .run(memberId, principal, account, createdAt);
    return Object.freeze({ memberId, principalId: principal, nearAccount: account, createdAt });
  }

  upsertMember({ memberId, principalId, nearAccount }) {
    const id = text(memberId, 'memberId');
    const principal = text(principalId, 'principalId');
    const account = text(nearAccount, 'nearAccount');
    this.db.prepare(`INSERT INTO app_members(member_id,principal_id,near_account,created_at)
      VALUES(?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET principal_id=excluded.principal_id,near_account=excluded.near_account`)
      .run(id, principal, account, this.clock());
  }

  setMembership({ circleId, memberId, status: membershipStatus = 'ACTIVE' }) {
    const circle = text(circleId, 'circleId');
    const member = text(memberId, 'memberId');
    const state = status(membershipStatus, STATUSES.member, 'memberStatus');
    const cycle = this.db.prepare('SELECT status FROM app_circle_cycles WHERE circle_id=?').get(circle);
    if (cycle?.status === 'STARTED' && this.db.prepare('SELECT status FROM app_circle_memberships WHERE circle_id=? AND member_id=?').get(circle, member)?.status !== state) {
      throw new Error('membership cannot change after the circle cycle starts');
    }
    this.db.prepare(`INSERT INTO app_circle_memberships(circle_id,member_id,status) VALUES(?,?,?)
      ON CONFLICT(circle_id,member_id) DO UPDATE SET status=excluded.status`)
      .run(circle, member, state);
  }

  setRound({ circleId, round, status: roundStatus = 'OPEN', contributionAmount, deadlineMs, deadlineNs }) {
    const circle = text(circleId, 'circleId');
    if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
    const state = status(roundStatus, STATUSES.round, 'roundStatus');
    const cycle = this.db.prepare('SELECT status FROM app_circle_cycles WHERE circle_id=?').get(circle);
    if (cycle?.status === 'STARTED') throw new Error('round configuration cannot change after the circle cycle starts');
    const contribution = amount(contributionAmount, 'contributionAmount');
    if (deadlineNs === undefined) {
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be a positive safe integer');
      deadlineNs = String(BigInt(deadlineMs) * 1000000n);
    }
    if (typeof deadlineNs !== 'string' || !/^[1-9][0-9]*$/.test(deadlineNs)) throw new Error('deadlineNs must be a positive integer string');
    const exactDeadline = BigInt(deadlineNs);
    const derivedDeadlineMs = exactDeadline / 1000000n;
    if (derivedDeadlineMs <= 0n || derivedDeadlineMs > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('deadlineNs is outside the supported timestamp range');
    const normalizedDeadlineMs = Number(derivedDeadlineMs);
    if (deadlineMs !== undefined && deadlineMs !== normalizedDeadlineMs) throw new Error('deadlineMs must equal the millisecond floor of deadlineNs');
    this.db.prepare(`INSERT INTO app_rounds(circle_id,round_number,status,contribution_amount,deadline_ms,deadline_ns)
      VALUES(?,?,?,?,?,?) ON CONFLICT(circle_id,round_number) DO UPDATE SET status=excluded.status,
      contribution_amount=excluded.contribution_amount,deadline_ms=excluded.deadline_ms,deadline_ns=excluded.deadline_ns`)
      .run(circle, round, state, contribution, normalizedDeadlineMs, deadlineNs);
  }

  setCircleAsset({ circleId, assetId, maxInputAmount, active = true }) {
    const circle = text(circleId, 'circleId');
    const asset = text(assetId, 'assetId');
    const max = amount(maxInputAmount, 'maxInputAmount');
    if (typeof active !== 'boolean') throw new Error('active must be a boolean');
    this.db.prepare(`INSERT INTO app_circle_assets(circle_id,asset_id,max_input_amount,active) VALUES(?,?,?,?)
      ON CONFLICT(circle_id,asset_id) DO UPDATE SET max_input_amount=excluded.max_input_amount,active=excluded.active`)
      .run(circle, asset, max, active ? 1 : 0);
  }

  setRefundAddress({ memberId, assetId, address, active = true }) {
    const member = text(memberId, 'memberId');
    const asset = text(assetId, 'assetId');
    const wallet = text(address, 'address');
    if (typeof active !== 'boolean') throw new Error('active must be a boolean');
    this.db.prepare(`INSERT INTO app_member_refund_addresses(member_id,asset_id,address,active,verification_status,verified_at,verification_method) VALUES(?,?,?,?,'UNVERIFIED',NULL,NULL)
      ON CONFLICT(member_id,asset_id) DO UPDATE SET address=excluded.address,active=excluded.active,verification_status='UNVERIFIED',verified_at=NULL,verification_method=NULL`)
      .run(member, asset, wallet, active ? 1 : 0);
  }

  /**
   * Verifies a previously registered refund address only when it matches the
   * authenticated principal's registered NEAR account and active circle records.
   * This is deliberately limited to NEAR NEP-141 asset identifiers.
   */
  registerNearRefundAddressForPrincipal({ principalId, circleId, assetId } = {}) {
    const principal = text(principalId, 'principalId');
    const circle = text(circleId, 'circleId');
    const asset = text(assetId, 'assetId');
    if (!asset.startsWith('nep141:')) throw new Error('only NEAR NEP-141 assets support this registration flow');
    const member = this.db.prepare("SELECT m.member_id, m.near_account FROM app_members m JOIN app_circle_memberships cm ON cm.member_id=m.member_id AND cm.circle_id=? JOIN app_circles c ON c.circle_id=cm.circle_id JOIN app_circle_assets a ON a.circle_id=c.circle_id AND a.asset_id=? WHERE m.principal_id=? AND cm.status='ACTIVE' AND c.status='ACTIVE' AND a.active=1").get(circle, asset, principal);
    if (!member) throw new Error('active membership and approved asset are required');
    const existing = this.db.prepare('SELECT address,active,verification_status FROM app_member_refund_addresses WHERE member_id=? AND asset_id=?').get(member.member_id, asset);
    if (existing) {
      if (existing.address !== member.near_account || existing.active !== 1) throw new Error('existing refund wallet conflicts with authenticated account; manual trusted review required');
      return Object.freeze({ circleId: circle, memberId: member.member_id, assetId: asset, address: existing.address, active: true, verificationStatus: existing.verification_status, alreadyRegistered: true });
    }
    this.db.prepare("INSERT INTO app_member_refund_addresses(member_id,asset_id,address,active,verification_status,verified_at,verification_method) VALUES(?,?,?,1,'UNVERIFIED',NULL,NULL)").run(member.member_id, asset, member.near_account);
    return Object.freeze({ circleId: circle, memberId: member.member_id, assetId: asset, address: member.near_account, active: true, verificationStatus: 'UNVERIFIED', alreadyRegistered: false });
  }
  verifyNearRefundAddressForPrincipal({ principalId, circleId, assetId, address } = {}) {
    const principal = text(principalId, 'principalId');
    const circle = text(circleId, 'circleId');
    const asset = text(assetId, 'assetId');
    const wallet = text(address, 'address');

    if (!asset.startsWith('nep141:')) {
      throw new Error('only NEAR NEP-141 assets support this verification flow');
    }

    const row = this.db.prepare(`
      SELECT m.member_id, m.near_account,
        cm.status AS member_status,
        c.status AS circle_status,
        a.active AS asset_active,
        w.address AS registered_address,
        w.active AS wallet_active
      FROM app_members m
      JOIN app_circle_memberships cm
        ON cm.member_id=m.member_id AND cm.circle_id=?
      JOIN app_circles c ON c.circle_id=cm.circle_id
      JOIN app_circle_assets a
        ON a.circle_id=c.circle_id AND a.asset_id=?
      JOIN app_member_refund_addresses w
        ON w.member_id=m.member_id AND w.asset_id=a.asset_id
      WHERE m.principal_id=?
    `).get(circle, asset, principal);

    if (!row || row.member_status !== 'ACTIVE' ||
        row.circle_status !== 'ACTIVE' || row.asset_active !== 1 ||
        row.wallet_active !== 1 || row.registered_address !== wallet ||
        row.near_account !== wallet) {
      throw new Error('NEAR refund wallet verification rejected');
    }

    const verifiedAt = this.clock();
    const verificationMethod = 'NEAR_AUTHENTICATED_ACCOUNT_MATCH';

    const result = this.db.prepare(`
      UPDATE app_member_refund_addresses
      SET verification_status='VERIFIED',
          verified_at=?,
          verification_method=?
      WHERE member_id=? AND asset_id=? AND address=? AND active=1
    `).run(verifiedAt, verificationMethod, row.member_id, asset, wallet);

    if (result.changes !== 1) {
      throw new Error('NEAR refund wallet verification rejected');
    }

    return Object.freeze({
      circleId: circle,
      memberId: row.member_id,
      assetId: asset,
      address: wallet,
      verificationStatus: 'VERIFIED',
      verifiedAt,
      verificationMethod
    });
  }
  createCirclePolicy({ circleId, policyVersion = 1, mode, gracePeriodDays, shortfallPolicy = 'WAIT_FOR_FULL_POT', penaltyBps }) {
    const circle = text(circleId, 'circleId');
    if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw new Error('policyVersion must be a positive safe integer');
    const policy = validateCirclePolicy({ mode, gracePeriodDays, shortfallPolicy, penaltyBps });
    const circleRecord = this.db.prepare('SELECT status FROM app_circles WHERE circle_id=?').get(circle);
    if (!circleRecord) throw new Error('circle does not exist');
    if (circleRecord.status !== 'ACTIVE') throw new Error('circle must be active to publish a policy');
    const roundCount = this.db.prepare('SELECT COUNT(*) AS count FROM app_rounds WHERE circle_id=?').get(circle).count;
    const cycleCount = this.db.prepare('SELECT COUNT(*) AS count FROM app_circle_cycles WHERE circle_id=?').get(circle).count;
    if (roundCount > 0) throw new Error('circle policy cannot be changed after rounds are configured');
    if (cycleCount > 0) throw new Error('circle policy cannot be changed after cycle configuration begins');
    const latest = this.db.prepare('SELECT MAX(policy_version) AS version FROM app_circle_policies WHERE circle_id=?').get(circle).version;
    const expectedVersion = latest === null ? 1 : latest + 1;
    if (policyVersion !== expectedVersion) throw new Error(`policyVersion must be ${expectedVersion}`);
    const canonical = JSON.stringify({ circleId: circle, policyVersion, ...policy });
    const policyHash = createHash('sha256').update(canonical).digest('hex');
    this.db.prepare(`INSERT INTO app_circle_policies
      (circle_id,policy_version,mode,publicly_discoverable,grace_period_days,shortfall_policy,penalty_bps,distribution_policy,policy_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(circle, policyVersion, policy.mode, policy.publiclyDiscoverable ? 1 : 0,
        policy.gracePeriodDays, policy.shortfallPolicy, policy.penaltyBps, policy.distributionPolicy, policyHash, this.clock());
    return this.getCirclePolicy({ circleId: circle, policyVersion });
  }

  getCirclePolicy({ circleId, policyVersion } = {}) {
    const circle = text(circleId, 'circleId');
    let row;
    if (policyVersion === undefined) {
      row = this.db.prepare('SELECT * FROM app_circle_policies WHERE circle_id=? ORDER BY policy_version DESC LIMIT 1').get(circle);
    } else {
      if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw new Error('policyVersion must be a positive safe integer');
      row = this.db.prepare('SELECT * FROM app_circle_policies WHERE circle_id=? AND policy_version=?').get(circle, policyVersion);
    }
    if (!row) return null;
    return Object.freeze({
      circleId: row.circle_id, policyVersion: row.policy_version, mode: row.mode,
      publiclyDiscoverable: row.publicly_discoverable === 1,
      invitationOnly: row.publicly_discoverable === 0,
      gracePeriodDays: row.grace_period_days, shortfallPolicy: row.shortfall_policy,
      penaltyBps: row.penalty_bps, distributionPolicy: row.distribution_policy ?? null,
      policyHash: row.policy_hash, createdAt: row.created_at,
    });
  }

  recordCirclePolicyAcceptance({ circleId, policyVersion, memberId, accepted }) {
    const circle = text(circleId, 'circleId');
    const member = text(memberId, 'memberId');
    if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw new Error('policyVersion must be a positive safe integer');
    if (accepted !== true) throw new Error('explicit policy acceptance is required');
    const policy = this.getCirclePolicy({ circleId: circle, policyVersion });
    if (!policy) throw new Error('circle policy version does not exist');
    if (!this.db.prepare('SELECT member_id FROM app_members WHERE member_id=?').get(member)) {
      throw new Error('member does not exist');
    }
    this.db.prepare(`INSERT INTO app_circle_policy_acceptances
      (circle_id,policy_version,member_id,policy_hash,accepted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(circle_id,policy_version,member_id) DO NOTHING`)
      .run(circle, policyVersion, member, policy.policyHash, this.clock());
    const row = this.db.prepare(`SELECT policy_hash,accepted_at FROM app_circle_policy_acceptances
      WHERE circle_id=? AND policy_version=? AND member_id=?`).get(circle, policyVersion, member);
    return Object.freeze({ circleId: circle, policyVersion, memberId: member, policyHash: row.policy_hash, acceptedAt: row.accepted_at });
  }

  hasAcceptedCirclePolicy({ circleId, policyVersion, memberId } = {}) {
    const circle = text(circleId, 'circleId');
    const member = text(memberId, 'memberId');
    if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw new Error('policyVersion must be a positive safe integer');
    const row = this.db.prepare(`SELECT p.policy_hash, a.policy_hash AS accepted_hash
      FROM app_circle_policies p LEFT JOIN app_circle_policy_acceptances a
      ON a.circle_id=p.circle_id AND a.policy_version=p.policy_version AND a.member_id=?
      WHERE p.circle_id=? AND p.policy_version=?`).get(member, circle, policyVersion);
    return Boolean(row && row.accepted_hash && row.accepted_hash === row.policy_hash);
  }

  provisionCircleCycle({ circleId, createdByMemberId, plannedRounds }) {
    const circle = text(circleId, 'circleId');
    const creator = text(createdByMemberId, 'createdByMemberId');
    if (!Number.isSafeInteger(plannedRounds) || plannedRounds < 2 || plannedRounds > 100) {
      throw new Error('plannedRounds must be an integer from 2 to 100');
    }
    const policy = this.getCirclePolicy({ circleId: circle });
    if (!policy) throw new Error('circle has no published policy');
    const circleRecord = this.db.prepare('SELECT status FROM app_circles WHERE circle_id=?').get(circle);
    if (!circleRecord || circleRecord.status !== 'ACTIVE') throw new Error('circle must be active to configure a cycle');
    const creatorMembership = this.db.prepare('SELECT status FROM app_circle_memberships WHERE circle_id=? AND member_id=?').get(circle, creator);
    if (!creatorMembership || creatorMembership.status !== 'ACTIVE') throw new Error('cycle creator must be an active circle member');
    const scheduleConfig = this.db.prepare('SELECT members_json FROM app_circle_contract_schedule_configs WHERE circle_id=?').get(circle);
    const configuredMembers = scheduleConfig ? JSON.parse(scheduleConfig.members_json) : null;
    const creatorAccount = this.db.prepare('SELECT m.near_account FROM app_circle_creators c JOIN app_members m ON m.member_id=c.member_id WHERE c.circle_id=?').get(circle)?.near_account;
    const memberCount = this.db.prepare("SELECT m.near_account FROM app_circle_memberships cm JOIN app_members m ON m.member_id=cm.member_id WHERE cm.circle_id=? AND cm.status='ACTIVE'").all(circle)
      .filter(row => !configuredMembers || configuredMembers.includes(row.near_account) || row.near_account !== creatorAccount).length;
    if (memberCount !== plannedRounds) throw new Error('plannedRounds must equal the current active member count');
    if (this.db.prepare('SELECT 1 FROM app_circle_cycles WHERE circle_id=?').get(circle)) throw new Error('cycle is already configured for this circle');
    if (this.db.prepare('SELECT 1 FROM app_rounds WHERE circle_id=?').get(circle)) throw new Error('configure the cycle before adding round schedules');
    this.db.prepare(`INSERT INTO app_circle_cycles
      (circle_id,created_by_member_id,policy_version,policy_hash,planned_rounds,status,created_at,started_at)
      VALUES(?,?,?,?,?,'DRAFT',?,NULL)`)
      .run(circle, creator, policy.policyVersion, policy.policyHash, plannedRounds, this.clock());
    return this.getCircleCycleStatus({ circleId: circle });
  }

  configureCircleCycle({ circleId, createdByMemberId, rounds }) {
    const circle = text(circleId, 'circleId');
    const creator = text(createdByMemberId, 'createdByMemberId');
    if (!Array.isArray(rounds) || rounds.length < 2 || rounds.length > 100) {
      throw new Error('rounds must contain 2 to 100 scheduled rounds');
    }
    let previousDeadlineNs = 0n;
    let contribution;
    const normalizedRounds = rounds.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('each round schedule must be an object');
      amount(item.contributionAmount, 'contributionAmount');
      if (index === 0) contribution = item.contributionAmount;
      if (item.contributionAmount !== contribution) throw new Error('all cycle rounds must use the same contribution amount');
      let deadlineNs = item.deadlineNs;
      if (deadlineNs === undefined) {
        if (!Number.isSafeInteger(item.deadlineMs) || item.deadlineMs <= 0) throw new Error('round deadlines must be positive timestamps');
        deadlineNs = String(BigInt(item.deadlineMs) * 1000000n);
      }
      if (typeof deadlineNs !== 'string' || !/^[1-9][0-9]*$/.test(deadlineNs)) throw new Error('round deadlineNs must be a positive integer string');
      const exactDeadline = BigInt(deadlineNs);
      const deadlineMs = Number(exactDeadline / 1000000n);
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0
          || (item.deadlineMs !== undefined && item.deadlineMs !== deadlineMs)
          || exactDeadline <= previousDeadlineNs) throw new Error('round deadlines must be strictly increasing exact timestamps');
      previousDeadlineNs = exactDeadline;
      return { contributionAmount: item.contributionAmount, deadlineMs, deadlineNs };
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare('SELECT member_id FROM app_circle_creators WHERE circle_id=?').get(circle);
      if (!owner || owner.member_id !== creator) throw new Error('only the circle creator may configure the cycle');
      this.provisionCircleCycle({ circleId: circle, createdByMemberId: creator, plannedRounds: normalizedRounds.length });
      normalizedRounds.forEach((item, round) => this.setRound({
        circleId: circle, round, status: 'OPEN', contributionAmount: item.contributionAmount, deadlineMs: item.deadlineMs, deadlineNs: item.deadlineNs,
      }));
      this.db.exec('COMMIT');
      return this.getCircleCycleStatus({ circleId: circle });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  getCircleCycleStatus({ circleId } = {}) {
    const circle = text(circleId, 'circleId');
    const cycle = this.db.prepare('SELECT * FROM app_circle_cycles WHERE circle_id=?').get(circle);
    if (!cycle) return null;
    const scheduleConfig = this.db.prepare('SELECT members_json FROM app_circle_contract_schedule_configs WHERE circle_id=?').get(circle);
    const participantAccounts = scheduleConfig ? JSON.parse(scheduleConfig.members_json) : null;
    const participantRows = participantAccounts
      ? participantAccounts.map(account => this.db.prepare("SELECT cm.member_id FROM app_circle_memberships cm JOIN app_members m ON m.member_id=cm.member_id WHERE cm.circle_id=? AND cm.status='ACTIVE' AND m.near_account=?").get(circle, account)).filter(Boolean)
      : this.db.prepare("SELECT member_id FROM app_circle_memberships WHERE circle_id=? AND status='ACTIVE'").all(circle);
    const activeMembers = participantRows.length;
    const acceptedMembers = participantRows.filter(member => this.hasAcceptedCirclePolicy({ circleId: circle, policyVersion: cycle.policy_version, memberId: member.member_id })).length;
    const rounds = this.db.prepare('SELECT round_number,status,contribution_amount,deadline_ms,deadline_ns FROM app_rounds WHERE circle_id=? ORDER BY round_number').all(circle);
    const configuredRounds = rounds.length;
    const firstContribution = rounds[0]?.contribution_amount;
    let previousDeadlineNs = 0n;
    const roundsReady = rounds.length === cycle.planned_rounds && rounds.every((round, index) => {
      let deadlineNs;
      try { deadlineNs = BigInt(round.deadline_ns); } catch { return false; }
      const valid = round.round_number === index && round.status === 'OPEN'
        && round.contribution_amount === firstContribution && deadlineNs > previousDeadlineNs;
      previousDeadlineNs = deadlineNs;
      return valid;
    });
    return Object.freeze({
      circleId: circle, status: cycle.status, createdByMemberId: cycle.created_by_member_id,
      policyVersion: cycle.policy_version, policyHash: cycle.policy_hash,
      plannedRounds: cycle.planned_rounds, activeMembers, acceptedMembers,
      configuredRounds, roundsReady, startedAt: cycle.started_at,
      ready: cycle.status === 'DRAFT' && activeMembers === cycle.planned_rounds
        && acceptedMembers === activeMembers && roundsReady,
    });
  }

  startCircleCycle({ circleId, requestedByMemberId, nowMs = Date.now() }) {
    const circle = text(circleId, 'circleId');
    const requester = text(requestedByMemberId, 'requestedByMemberId');
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('nowMs must be a positive safe integer');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cycle = this.db.prepare('SELECT * FROM app_circle_cycles WHERE circle_id=?').get(circle);
      if (!cycle) throw new Error('cycle has not been provisioned');
      if (cycle.status !== 'DRAFT') throw new Error('cycle is not in DRAFT state');
      if (cycle.created_by_member_id !== requester) throw new Error('only the cycle creator may start the cycle');
      const circleRecord = this.db.prepare('SELECT status FROM app_circles WHERE circle_id=?').get(circle);
      if (!circleRecord || circleRecord.status !== 'ACTIVE') throw new Error('circle is not active');
      const policy = this.getCirclePolicy({ circleId: circle });
      if (!policy || policy.policyVersion !== cycle.policy_version || policy.policyHash !== cycle.policy_hash) {
        throw new Error('cycle policy changed after configuration');
      }
      if (!policy.distributionPolicy) {
        throw new Error('cycle cannot start because its accepted policy has no explicit distribution rule');
      }
      const scheduleConfig = this.db.prepare('SELECT members_json FROM app_circle_contract_schedule_configs WHERE circle_id=?').get(circle);
      const participantAccounts = scheduleConfig ? JSON.parse(scheduleConfig.members_json) : null;
      const members = participantAccounts
        ? participantAccounts.map(account => this.db.prepare("SELECT cm.member_id FROM app_circle_memberships cm JOIN app_members m ON m.member_id=cm.member_id WHERE cm.circle_id=? AND cm.status='ACTIVE' AND m.near_account=?").get(circle, account)).filter(Boolean)
        : this.db.prepare("SELECT member_id FROM app_circle_memberships WHERE circle_id=? AND status='ACTIVE' ORDER BY member_id").all(circle);
      if (members.length !== cycle.planned_rounds) throw new Error('active participant count no longer matches planned rounds');
      for (const member of members) {
        if (!this.hasAcceptedCirclePolicy({ circleId: circle, policyVersion: cycle.policy_version, memberId: member.member_id })) {
          throw new Error('every active member must accept the exact cycle policy before start');
        }
      }
      const rounds = this.db.prepare('SELECT round_number,status,contribution_amount,deadline_ms,deadline_ns FROM app_rounds WHERE circle_id=? ORDER BY round_number').all(circle);
      if (rounds.length !== cycle.planned_rounds) throw new Error('every planned round must be configured before start');
      const contribution = rounds[0]?.contribution_amount;
      let previousDeadlineNs = 0n;
      for (let index = 0; index < rounds.length; index += 1) {
        const round = rounds[index];
        if (round.round_number !== index || round.status !== 'OPEN') throw new Error('rounds must be consecutively numbered from zero and open');
        if (round.contribution_amount !== contribution) throw new Error('all cycle rounds must use the same contribution amount');
        let deadlineNs;
        try { deadlineNs = BigInt(round.deadline_ns); } catch { throw new Error('round deadline precision is invalid'); }
        if (deadlineNs <= previousDeadlineNs) throw new Error('round deadlines must be strictly increasing');
        previousDeadlineNs = deadlineNs;
      }
      const updated = this.db.prepare("UPDATE app_circle_cycles SET status='STARTED',started_at=? WHERE circle_id=? AND status='DRAFT'")
        .run(new Date(nowMs).toISOString(), circle);
      if (updated.changes !== 1) throw new Error('cycle start state changed concurrently');
      this.db.exec('COMMIT');
      return this.getCircleCycleStatus({ circleId: circle });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  getCircleInvitationContext({ circleId, token, nowMs = Date.now() }) {
    const circle = text(circleId, 'circleId');
    const rawToken = text(token, 'token');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('nowMs must be a non-negative safe integer');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const row = this.db.prepare(`SELECT expires_at_ms, max_uses, use_count FROM app_circle_invitations
      WHERE token_hash=? AND circle_id=? AND revoked=0 AND expires_at_ms>? AND use_count<max_uses`).get(tokenHash, circle, nowMs);
    if (!row) return null;
    return Object.freeze({ circleId: circle, expiresAtMs: row.expires_at_ms, maxUses: row.max_uses, usesRemaining: row.max_uses - row.use_count });
  }

  createCircleInvitation({ circleId, createdByMemberId, expiresAtMs, maxUses = 1, nowMs = Date.now() }) {
    const circle = text(circleId, 'circleId');
    const creator = text(createdByMemberId, 'createdByMemberId');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('nowMs must be a non-negative safe integer');
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw new Error('expiresAtMs must be in the future');
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 100) throw new Error('maxUses must be an integer from 1 to 100');
    const policy = this.getCirclePolicy({ circleId: circle });
    if (!policy || policy.mode !== 'PRIVATE_TRUSTED') throw new Error('invitations are only available for private trusted circles');
    const membership = this.db.prepare(`SELECT cm.status, c.status AS circle_status FROM app_circle_memberships cm
      JOIN app_circles c ON c.circle_id=cm.circle_id WHERE cm.circle_id=? AND cm.member_id=?`).get(circle, creator);
    if (!membership || membership.status !== 'ACTIVE' || membership.circle_status !== 'ACTIVE') {
      throw new Error('only an active member of this circle may create invitations');
    }
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.db.prepare(`INSERT INTO app_circle_invitations
      (token_hash,circle_id,created_by_member_id,expires_at_ms,max_uses,use_count,revoked,created_at)
      VALUES(?,?,?,?,?,0,0,?)`).run(tokenHash, circle, creator, expiresAtMs, maxUses, this.clock());
    return Object.freeze({ token, circleId: circle, policyVersion: policy.policyVersion, expiresAtMs, maxUses });
  }

  revokeCircleInvitation({ circleId, createdByMemberId, token }) {
    const circle = text(circleId, 'circleId');
    const creator = text(createdByMemberId, 'createdByMemberId');
    const rawToken = text(token, 'token');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const result = this.db.prepare(`UPDATE app_circle_invitations SET revoked=1
      WHERE token_hash=? AND circle_id=? AND created_by_member_id=? AND revoked=0`)
      .run(tokenHash, circle, creator);
    if (result.changes !== 1) throw new Error('active invitation not found for this creator and circle');
    return true;
  }

  joinCircleAfterPolicyAcceptance({ circleId, memberId, inviteToken, nowMs = Date.now() }) {
    const circle = text(circleId, 'circleId');
    const member = text(memberId, 'memberId');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('nowMs must be a non-negative safe integer');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const circleRecord = this.db.prepare('SELECT status FROM app_circles WHERE circle_id=?').get(circle);
      if (!circleRecord || circleRecord.status !== 'ACTIVE') throw new Error('circle is not active');
      const policy = this.getCirclePolicy({ circleId: circle });
      if (!policy) throw new Error('circle has no published policy');
      if (!this.hasAcceptedCirclePolicy({ circleId: circle, policyVersion: policy.policyVersion, memberId: member })) {
        throw new Error('member must accept the current circle policy before joining');
      }
      if (policy.mode === 'PRIVATE_TRUSTED') {
        const existingMembership = this.db.prepare("SELECT status FROM app_circle_memberships WHERE circle_id=? AND member_id=?").get(circle, member);
        if (existingMembership?.status !== 'ACTIVE') {
          const token = text(inviteToken, 'inviteToken');
          const tokenHash = createHash('sha256').update(token).digest('hex');
          const consumed = this.db.prepare(`UPDATE app_circle_invitations SET use_count=use_count+1
            WHERE token_hash=? AND circle_id=? AND revoked=0 AND expires_at_ms>? AND use_count<max_uses`)
            .run(tokenHash, circle, nowMs);
          if (consumed.changes !== 1) throw new Error('invitation is invalid, expired, revoked, or already used');
        }
      } else if (inviteToken !== undefined) {
        throw new Error('public circles do not accept private invitation tokens');
      }
      this.setMembership({ circleId: circle, memberId: member, status: 'ACTIVE' });
      this.db.exec('COMMIT');
      return Object.freeze({ circleId: circle, memberId: member, policyVersion: policy.policyVersion, status: 'ACTIVE' });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  findMembershipForPrincipal({ principalId, circleId } = {}) {
    const principal = text(principalId, 'principalId');
    const circle = text(circleId, 'circleId');
    const row = this.db.prepare(`
      SELECT m.member_id, cm.circle_id, cm.status AS member_status, c.status AS circle_status
      FROM app_members m
      JOIN app_circle_memberships cm ON cm.member_id=m.member_id
      JOIN app_circles c ON c.circle_id=cm.circle_id
      WHERE m.principal_id=? AND cm.circle_id=?
    `).get(principal, circle);
    if (!row || row.member_status !== 'ACTIVE' || row.circle_status !== 'ACTIVE') return null;
    return Object.freeze({ circleId: row.circle_id, memberId: row.member_id, status: row.member_status });
  }

  getMemberQuoteContext({ circleId, memberId, round, allowStaleBindingForEvidence = false } = {}) {
    if (typeof allowStaleBindingForEvidence !== 'boolean') throw new Error('allowStaleBindingForEvidence must be boolean');
    const circle = text(circleId, 'circleId');
    const member = text(memberId, 'memberId');
    if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
    const row = this.db.prepare(`
      SELECT c.circle_id, c.contract_id, c.status AS circle_status,
        m.member_id, m.near_account, cm.status AS member_status,
        r.round_number, r.status AS round_status, r.contribution_amount, r.deadline_ms, r.deadline_ns
      FROM app_circles c
      JOIN app_circle_memberships cm ON cm.circle_id=c.circle_id
      JOIN app_members m ON m.member_id=cm.member_id
      JOIN app_rounds r ON r.circle_id=c.circle_id
      WHERE c.circle_id=? AND m.member_id=? AND r.round_number=?
    `).get(circle, member, round);
    if (!row) return null;
    // Verified code alone is not enough: quotes stay blocked until the local schedule can be proven to match on-chain configuration.
    if (this.db.prepare('SELECT 1 FROM app_circle_creators WHERE circle_id=?').get(circle)) {
      const binding = this.getVerifiedContractBinding({ circleId: circle });
      if (!binding || (!allowStaleBindingForEvidence && (!binding.quoteReady || binding.currentRound !== round))) return null;
      if (allowStaleBindingForEvidence && (!binding.verification?.verified || binding.network !== 'testnet'
          || binding.contractId !== row.contract_id
          || !APPROVED_AJOCIRCLE_TESTNET_SHA256S.includes(String(binding.codeSha256).toLowerCase()))) return null;
      const nowMs = Date.parse(this.clock());
      const verificationAgeMs = nowMs - Date.parse(binding.verifiedAt);
      if (!Number.isFinite(nowMs) || (!allowStaleBindingForEvidence && (!Number.isFinite(verificationAgeMs)
          || verificationAgeMs < 0 || verificationAgeMs > 60_000))) {
        this.invalidateQuoteReadiness({
          circleId: circle,
          reason: 'Verified contract binding is stale or has an invalid verification timestamp; re-verify before requesting a quote.',
        });
        return null;
      }
      const verifiedRound = binding.verification?.rounds?.[round];
      const expectedDeadlineNs = row.deadline_ns;
      // Persistently invalidate quote readiness when the live deadline has passed.
      try {
        if (!allowStaleBindingForEvidence && BigInt(expectedDeadlineNs) <= BigInt(nowMs) * 1000000n) {
          this.invalidateQuoteReadiness({
            circleId: circle,
            reason: 'The verified round deadline has expired; re-verify the current contract lifecycle before requesting a quote.',
          });
          return null;
        }
      } catch {
        this.invalidateQuoteReadiness({
          circleId: circle,
          reason: 'The stored round deadline is invalid; reconfigure and re-verify before requesting a quote.',
        });
        return null;
      }
      if (binding.roundDeadline !== expectedDeadlineNs
          || binding.verification?.roundDeadline !== expectedDeadlineNs
          || !verifiedRound || verifiedRound.round !== round
          || verifiedRound.contributionAmount !== row.contribution_amount
          || verifiedRound.deadlineNs !== expectedDeadlineNs) {
        this.invalidateQuoteReadiness({
          circleId: circle,
          reason: 'The cached verification no longer matches the local round schedule; re-verify before requesting a quote.',
        });
        return null;
      }
    }
    const cycle = this.db.prepare('SELECT status FROM app_circle_cycles WHERE circle_id=?').get(circle);
    if (cycle && cycle.status !== 'STARTED') return null;

    const assets = this.db.prepare(`SELECT a.asset_id, a.max_input_amount, w.address
      FROM app_circle_assets a
      JOIN app_member_refund_addresses w ON w.asset_id=a.asset_id AND w.member_id=?
      WHERE a.circle_id=? AND a.active=1 AND w.active=1
        AND w.verification_status='VERIFIED' AND w.verified_at IS NOT NULL
        AND w.verification_method IS NOT NULL
      ORDER BY a.asset_id`).all(member, circle);
    const allowedOriginAssets = assets.map(item => item.asset_id);
    const refundAddresses = Object.fromEntries(assets.map(item => [item.asset_id, item.address]));
    const maxInputAmounts = Object.fromEntries(assets.map(item => [item.asset_id, item.max_input_amount]));

    return Object.freeze({
      circleId: row.circle_id,
      memberId: row.member_id,
      round: row.round_number,
      circleStatus: row.circle_status,
      memberStatus: row.member_status,
      roundStatus: row.round_status,
      memberNearAccount: row.near_account,
      requiredContributionAmount: row.contribution_amount,
      allowedOriginAssets,
      refundAddresses,
      maxInputAmounts,
      contractId: row.contract_id,
      roundDeadlineMs: row.deadline_ms,
      roundDeadlineNs: row.deadline_ns,
    });
  }

  close() { this.db.close(); }
}
