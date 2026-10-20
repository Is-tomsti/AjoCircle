import { DatabaseSync } from 'node:sqlite';

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
      CREATE TABLE IF NOT EXISTS app_rounds (
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        round_number INTEGER NOT NULL CHECK(round_number >= 0),
        status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED','COMPLETE')),
        contribution_amount TEXT NOT NULL CHECK(length(contribution_amount) > 0 AND contribution_amount NOT GLOB '*[^0-9]*' AND contribution_amount != '0'),
        deadline_ms INTEGER NOT NULL CHECK(deadline_ms > 0),
        PRIMARY KEY(circle_id, round_number)
      );
      CREATE TABLE IF NOT EXISTS app_circle_assets (
        circle_id TEXT NOT NULL REFERENCES app_circles(circle_id),
        asset_id TEXT NOT NULL,
        max_input_amount TEXT NOT NULL CHECK(length(max_input_amount) > 0 AND max_input_amount NOT GLOB '*[^0-9]*' AND max_input_amount != '0'),
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        PRIMARY KEY(circle_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS app_member_refund_addresses (
        member_id TEXT NOT NULL REFERENCES app_members(member_id),
        asset_id TEXT NOT NULL,
        address TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        PRIMARY KEY(member_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS app_membership_by_member ON app_circle_memberships(member_id);
      CREATE INDEX IF NOT EXISTS app_round_lookup ON app_rounds(circle_id, round_number, status);
    `);
  }

  // These writes belong to trusted server-side circle setup/admin workflows.
  upsertCircle({ circleId, contractId, status: circleStatus = 'ACTIVE' }) {
    const id = text(circleId, 'circleId');
    const contract = text(contractId, 'contractId');
    const state = status(circleStatus, STATUSES.circle, 'circleStatus');
    this.db.prepare(`INSERT INTO app_circles(circle_id,contract_id,status,created_at)
      VALUES(?,?,?,?) ON CONFLICT(circle_id) DO UPDATE SET contract_id=excluded.contract_id,status=excluded.status`)
      .run(id, contract, state, this.clock());
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
    this.db.prepare(`INSERT INTO app_circle_memberships(circle_id,member_id,status) VALUES(?,?,?)
      ON CONFLICT(circle_id,member_id) DO UPDATE SET status=excluded.status`)
      .run(circle, member, state);
  }

  setRound({ circleId, round, status: roundStatus = 'OPEN', contributionAmount, deadlineMs }) {
    const circle = text(circleId, 'circleId');
    if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
    const state = status(roundStatus, STATUSES.round, 'roundStatus');
    const contribution = amount(contributionAmount, 'contributionAmount');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be a positive safe integer');
    this.db.prepare(`INSERT INTO app_rounds(circle_id,round_number,status,contribution_amount,deadline_ms)
      VALUES(?,?,?,?,?) ON CONFLICT(circle_id,round_number) DO UPDATE SET status=excluded.status,
      contribution_amount=excluded.contribution_amount,deadline_ms=excluded.deadline_ms`)
      .run(circle, round, state, contribution, deadlineMs);
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
    this.db.prepare(`INSERT INTO app_member_refund_addresses(member_id,asset_id,address,active) VALUES(?,?,?,?)
      ON CONFLICT(member_id,asset_id) DO UPDATE SET address=excluded.address,active=excluded.active`)
      .run(member, asset, wallet, active ? 1 : 0);
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

  getMemberQuoteContext({ circleId, memberId, round } = {}) {
    const circle = text(circleId, 'circleId');
    const member = text(memberId, 'memberId');
    if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a non-negative safe integer');
    const row = this.db.prepare(`
      SELECT c.circle_id, c.contract_id, c.status AS circle_status,
        m.member_id, m.near_account, cm.status AS member_status,
        r.round_number, r.status AS round_status, r.contribution_amount, r.deadline_ms
      FROM app_circles c
      JOIN app_circle_memberships cm ON cm.circle_id=c.circle_id
      JOIN app_members m ON m.member_id=cm.member_id
      JOIN app_rounds r ON r.circle_id=c.circle_id
      WHERE c.circle_id=? AND m.member_id=? AND r.round_number=?
    `).get(circle, member, round);
    if (!row) return null;

    const assets = this.db.prepare(`SELECT a.asset_id, a.max_input_amount, w.address
      FROM app_circle_assets a
      JOIN app_member_refund_addresses w ON w.asset_id=a.asset_id AND w.member_id=?
      WHERE a.circle_id=? AND a.active=1 AND w.active=1 ORDER BY a.asset_id`).all(member, circle);
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
    });
  }

  close() { this.db.close(); }
}
