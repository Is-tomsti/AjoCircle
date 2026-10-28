import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Append-only durable handoff between chain/indexer verification and reputation
 * scoring. Only server-side code should hold this store. Rows are immutable;
 * transaction hash and evidence reference are unique across the database.
 */
export class ContributionEvidenceStore {
  constructor({ path = ':memory:' } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verified_contribution_evidence (
        evidence_ref TEXT PRIMARY KEY,
        transaction_hash TEXT NOT NULL UNIQUE,
        circle_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        signer_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        round_number INTEGER NOT NULL CHECK(round_number >= 0),
        amount_yocto TEXT NOT NULL,
        deadline_ns TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        base_digest TEXT NOT NULL,
        round_proof_ref TEXT NOT NULL,
        round_proof_digest TEXT NOT NULL,
        record_digest TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  recordVerifiedEvidence({ evidence, binding, circleId, memberId, round, expectedAmountYocto, expectedDeadlineNs } = {}) {
    if (!evidence || evidence.verified !== true || evidence.outcome !== 'ON_TIME') throw new Error('Verified on-time base evidence is required');
    if (!binding || binding.verified !== true) throw new Error('Verified historical round binding is required');
    const transactionHash = required(evidence.transactionHash, 'evidence.transactionHash');
    const evidenceRef = required(evidence.evidenceRef, 'evidence.evidenceRef');
    const circle = required(circleId, 'circleId');
    const member = required(memberId, 'memberId');
    const signer = required(evidence.signerId, 'evidence.signerId');
    const contract = required(evidence.contractId, 'evidence.contractId');
    const blockHash = required(evidence.blockHash, 'evidence.blockHash');
    const baseDigest = required(evidence.digest, 'evidence.digest');
    const proofRef = required(binding.proofRef, 'binding.proofRef');
    const proofDigest = required(binding.proofDigest, 'binding.proofDigest');
    if (!Number.isSafeInteger(round) || round < 0 || binding.round !== round || binding.transactionHash !== transactionHash
      || binding.contractId !== contract || binding.signerId !== signer || binding.circleId !== circle || binding.blockHash !== blockHash) {
      throw new Error('Verified evidence and round binding do not describe the same trusted obligation');
    }
    if (evidence.amountYocto !== expectedAmountYocto || evidence.deadlineNs !== expectedDeadlineNs
      || binding.network !== 'testnet' || evidence.network !== 'testnet'
      || evidenceRef !== `near:testnet:tx:${transactionHash}`) {
      throw new Error('Evidence does not match the trusted testnet obligation');
    }
    const record = { evidenceRef, transactionHash, circleId: circle, memberId: member, signerId: signer,
      contractId: contract, round, amountYocto: expectedAmountYocto, deadlineNs: expectedDeadlineNs,
      blockHash, baseDigest, roundProofRef: proofRef, roundProofDigest: proofDigest };
    const recordDigest = digest(record);
    try {
      this.db.prepare(`INSERT INTO verified_contribution_evidence
        (evidence_ref,transaction_hash,circle_id,member_id,signer_id,contract_id,round_number,amount_yocto,deadline_ns,block_hash,base_digest,round_proof_ref,round_proof_digest,record_digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.evidenceRef, record.transactionHash, record.circleId, record.memberId,
        record.signerId, record.contractId, record.round, record.amountYocto, record.deadlineNs, record.blockHash,
        record.baseDigest, record.roundProofRef, record.roundProofDigest, recordDigest);
    } catch (error) {
      if (!String(error?.message ?? '').includes('UNIQUE constraint failed')) throw error;
      const existing = this.db.prepare('SELECT evidence_ref, transaction_hash, record_digest FROM verified_contribution_evidence WHERE evidence_ref=? OR transaction_hash=?').get(record.evidenceRef, record.transactionHash);
      if (!existing || existing.evidence_ref !== record.evidenceRef || existing.transaction_hash !== record.transactionHash || existing.record_digest !== recordDigest) {
        throw new Error('Conflicting verified evidence already exists for this transaction');
      }
      // Exact same immutable evidence: safely permit a retry.
    }
    return Object.freeze({ evidenceRef, digest: recordDigest, verified: true });
  }

  findVerifiedEvidence({ circleId, memberId, round } = {}) {
    const circle = required(circleId, 'circleId');
    const member = required(memberId, 'memberId');
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new Error('round must be a non-negative safe integer');
    }
    const row = this.db.prepare(`
      SELECT evidence_ref, transaction_hash, circle_id, member_id, signer_id,
        contract_id, round_number, amount_yocto, deadline_ns, block_hash,
        record_digest, recorded_at
      FROM verified_contribution_evidence
      WHERE circle_id=? AND member_id=? AND round_number=?
    `).get(circle, member, round);
    if (!row) return null;
    return Object.freeze({
      evidenceRef: row.evidence_ref,
      transactionHash: row.transaction_hash,
      circleId: row.circle_id,
      memberId: row.member_id,
      signerId: row.signer_id,
      contractId: row.contract_id,
      round: row.round_number,
      amountYocto: row.amount_yocto,
      deadlineNs: row.deadline_ns,
      blockHash: row.block_hash,
      digest: row.record_digest,
      recordedAt: row.recorded_at
    });
  }

  verifyReference({ evidenceRef, memberId, circleId, eventKind, payload } = {}) {
    const ref = required(evidenceRef, 'evidenceRef');
    const row = this.db.prepare('SELECT * FROM verified_contribution_evidence WHERE evidence_ref=?').get(ref);
    if (!row) return Object.freeze({ verified: false });
    const record = { evidenceRef: row.evidence_ref, transactionHash: row.transaction_hash, circleId: row.circle_id,
      memberId: row.member_id, signerId: row.signer_id, contractId: row.contract_id, round: row.round_number,
      amountYocto: row.amount_yocto, deadlineNs: row.deadline_ns, blockHash: row.block_hash,
      baseDigest: row.base_digest, roundProofRef: row.round_proof_ref, roundProofDigest: row.round_proof_digest };
    if (digest(record) !== row.record_digest || record.memberId !== memberId || record.circleId !== circleId || eventKind !== 'OBLIGATION'
      || payload?.obligationId !== `${record.circleId}:${record.round}:${record.memberId}` || payload?.outcome !== 'ON_TIME') {
      return Object.freeze({ verified: false });
    }
    return Object.freeze({ verified: true, digest: row.record_digest });
  }

  close() { this.db.close(); }
}
