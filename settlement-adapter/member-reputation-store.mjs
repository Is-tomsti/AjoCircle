import { DatabaseSync } from 'node:sqlite';
import { buildMemberReputationProfile } from './member-reputation.mjs';

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function canonicalPayload(eventKind, payload, event) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  if (eventKind === 'OBLIGATION') {
    const obligationId = requiredText(payload.obligationId, 'payload.obligationId');
    if (!['ON_TIME', 'LATE', 'CURED_DEFAULT', 'MISSED', 'CONFIRMED_DEFAULT'].includes(payload.outcome)) {
      throw new Error('unsupported obligation outcome');
    }
    return { obligationId, outcome: payload.outcome };
  }
  if (eventKind === 'CIRCLE') {
    if (!['ROUND_COMPLETED', 'POT_RECEIVED', 'CIRCLE_COMPLETED'].includes(payload.type)) {
      throw new Error('unsupported circle event type');
    }
    const circleId = requiredText(payload.circleId, 'payload.circleId');
    if (circleId !== event.circleId) throw new Error('payload circleId must match the evidence record circleId');
    const result = { type: payload.type, circleId };
    if (payload.type !== 'CIRCLE_COMPLETED') {
      if (!Number.isSafeInteger(payload.round) || payload.round < 0) throw new Error('payload.round must be a non-negative safe integer');
      result.round = payload.round;
    }
    return result;
  }
  throw new Error('unsupported eventKind');
}

/**
 * Server-side append-only reputation evidence store. The caller must inject a
 * trusted verifier that checks referenced contract/settlement evidence and an
 * authorization callback for dispute decisions. Never expose this object or
 * its write methods directly to browser clients.
 */
export class MemberReputationStore {
  constructor({ path = ':memory:', verifyEvidence, authorizeReviewer } = {}) {
    if (typeof verifyEvidence !== 'function') throw new Error('trusted verifyEvidence callback is required');
    if (typeof authorizeReviewer !== 'function') throw new Error('trusted authorizeReviewer callback is required');
    this.db = new DatabaseSync(path);
    this.verifyEvidence = verifyEvidence;
    this.authorizeReviewer = authorizeReviewer;
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reputation_events (
        event_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        circle_id TEXT NOT NULL,
        event_kind TEXT NOT NULL CHECK(event_kind IN ('OBLIGATION','CIRCLE')),
        payload_json TEXT NOT NULL,
        evidence_ref TEXT NOT NULL UNIQUE,
        evidence_digest TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS reputation_disputes (
        event_id TEXT PRIMARY KEY REFERENCES reputation_events(event_id),
        status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED_UPHELD','RESOLVED_REVERSED')),
        reason TEXT NOT NULL,
        reviewed_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    // Safe additive migration for databases created by the first prototype.
    const disputeColumns = this.db.prepare('PRAGMA table_info(reputation_disputes)').all().map(column => column.name);
    if (!disputeColumns.includes('reviewed_by')) this.db.exec('ALTER TABLE reputation_disputes ADD COLUMN reviewed_by TEXT');
  }

  appendVerifiedEvent({ eventId, memberId, circleId, eventKind, payload, evidenceRef }) {
    const event = {
      eventId: requiredText(eventId, 'eventId'),
      memberId: requiredText(memberId, 'memberId'),
      circleId: requiredText(circleId, 'circleId'),
      evidenceRef: requiredText(evidenceRef, 'evidenceRef'),
    };
    if (!['OBLIGATION', 'CIRCLE'].includes(eventKind)) throw new Error('unsupported eventKind');
    const canonical = canonicalPayload(eventKind, payload, event);
    const evidence = this.verifyEvidence({ ...event, eventKind, payload: structuredClone(canonical) });
    if (!evidence || evidence.verified !== true || typeof evidence.digest !== 'string' || !evidence.digest.trim()) {
      throw new Error('evidence did not pass trusted verification');
    }
    const serialized = JSON.stringify(canonical);
    this.db.prepare(`INSERT INTO reputation_events
      (event_id,member_id,circle_id,event_kind,payload_json,evidence_ref,evidence_digest)
      VALUES(?,?,?,?,?,?,?)`).run(event.eventId, event.memberId, event.circleId, eventKind, serialized, event.evidenceRef, evidence.digest.trim());
    return Object.freeze({ ...event, eventKind, evidenceDigest: evidence.digest.trim(), verified: true });
  }

  openDispute({ eventId, reason }) {
    const id = requiredText(eventId, 'eventId');
    const why = requiredText(reason, 'reason');
    if (!this.db.prepare('SELECT 1 FROM reputation_events WHERE event_id=?').get(id)) throw new Error('reputation event not found');
    const existing = this.db.prepare('SELECT status FROM reputation_disputes WHERE event_id=?').get(id);
    if (existing) throw new Error('a dispute record already exists; use the authorized review workflow');
    this.db.prepare(`INSERT INTO reputation_disputes(event_id,status,reason) VALUES(?,'OPEN',?)`).run(id, why);
    return Object.freeze({ eventId: id, status: 'OPEN' });
  }

  resolveDispute({ eventId, decision, reason, reviewerId }) {
    const id = requiredText(eventId, 'eventId');
    const reviewer = requiredText(reviewerId, 'reviewerId');
    const why = requiredText(reason, 'reason');
    if (!['RESOLVED_UPHELD', 'RESOLVED_REVERSED'].includes(decision)) throw new Error('unsupported dispute decision');
    if (this.authorizeReviewer({ reviewerId: reviewer, eventId: id, decision }) !== true) {
      throw new Error('reviewer is not authorized to resolve reputation disputes');
    }
    const result = this.db.prepare(`UPDATE reputation_disputes SET status=?,reason=?,reviewed_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id=? AND status='OPEN'`).run(decision, why, reviewer, id);
    if (result.changes !== 1) throw new Error('open dispute not found');
    return Object.freeze({ eventId: id, status: decision, reviewedBy: reviewer });
  }

  getMemberProfile({ memberId }) {
    const member = requiredText(memberId, 'memberId');
    const rows = this.db.prepare(`SELECT e.*, d.status AS dispute_status FROM reputation_events e
      LEFT JOIN reputation_disputes d ON d.event_id=e.event_id WHERE e.member_id=? ORDER BY e.recorded_at,e.event_id`).all(member);
    const obligations = [];
    const circleEvents = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      const event = { ...payload, eventId: row.event_id, verified: true,
        evidenceRef: row.evidence_ref, evidenceDigest: row.evidence_digest };
      if (row.dispute_status) event.disputeStatus = row.dispute_status;
      if (row.event_kind === 'OBLIGATION') obligations.push(event);
      else circleEvents.push(event);
    }
    return buildMemberReputationProfile({ obligations, circleEvents });
  }

  close() { this.db.close(); }
}
