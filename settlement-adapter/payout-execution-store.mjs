import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const STATES = new Set(['PREPARED', 'AUTHORIZED', 'SUBMITTED', 'UNKNOWN', 'FINALIZED', 'FAILED']);
const TERMINAL = new Set(['FINALIZED', 'FAILED']);
const HASH_RE = /^[a-f0-9]{64}$/i;
const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function account(value, name) {
  const result = text(value, name);
  if (!/^[a-z0-9._-]{2,64}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function rowToPlan(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, idempotencyKey: row.idempotency_key, network: row.network,
    circleId: row.circle_id, contractId: row.contract_id, codeSha256: row.code_sha256,
    round: row.round_number, recipient: row.recipient, amountYocto: row.amount_yocto,
    state: row.state, preparedBy: row.prepared_by, authorizedBy: row.authorized_by,
    authorizationPhrase: row.authorization_phrase, txHash: row.tx_hash,
    finalityEvidence: row.finality_evidence ? JSON.parse(row.finality_evidence) : null,
    failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

/**
 * Durable state ledger only. This class cannot sign, submit, retry, or verify
 * a chain transaction. A separate trusted caller must independently verify
 * finalized chain evidence before recording FINALIZED.
 */
export class PayoutExecutionStore {
  constructor({ path = ':memory:', clock = () => new Date().toISOString() } = {}) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payout_execution_plans (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        network TEXT NOT NULL CHECK (network = 'testnet'),
        circle_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        code_sha256 TEXT NOT NULL CHECK (length(code_sha256) = 64),
        round_number INTEGER NOT NULL CHECK (round_number >= 0),
        recipient TEXT NOT NULL,
        amount_yocto TEXT NOT NULL CHECK (amount_yocto NOT GLOB '*[^0-9]*' AND length(amount_yocto) > 0),
        state TEXT NOT NULL CHECK (state IN ('PREPARED','AUTHORIZED','SUBMITTED','UNKNOWN','FINALIZED','FAILED')),
        prepared_by TEXT NOT NULL,
        authorized_by TEXT,
        authorization_phrase TEXT,
        tx_hash TEXT,
        finality_evidence TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(contract_id, round_number)
      );
    `);
  }

  prepare({ readiness, circleId, preparedBy }) {
    if (!readiness || readiness.status !== 'ready' || readiness.transactionSubmitted !== false) {
      throw new Error('A fresh read-only readiness result with status ready is required');
    }
    if (readiness.network !== 'testnet') throw new Error('Payout execution planning is testnet-only');
    const contractId = account(readiness.contractId, 'contractId');
    const recipient = account(readiness.recipient, 'recipient');
    const trustedCircleId = text(circleId, 'circleId');
    const actor = account(preparedBy, 'preparedBy');
    if (!Number.isSafeInteger(readiness.round) || readiness.round < 0) throw new Error('round is invalid');
    if (typeof readiness.codeSha256 !== 'string' || !HASH_RE.test(readiness.codeSha256)) {
      throw new Error('Approved deployed code hash is required');
    }
    if (typeof readiness.bindingVerified !== 'boolean' || readiness.bindingVerified !== true) {
      throw new Error('Verified approved contract binding is required');
    }
    if (typeof readiness.amountYocto !== 'string' || !/^[1-9][0-9]*$/.test(readiness.amountYocto)) {
      throw new Error('Exact positive payout amount in yoctoNEAR is required');
    }
    const idempotencyKey = createHash('sha256')
      .update(`testnet|${contractId}|${readiness.round}`).digest('hex');
    const now = this.clock();
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO payout_execution_plans
        (id,idempotency_key,network,circle_id,contract_id,code_sha256,round_number,recipient,amount_yocto,state,prepared_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'PREPARED',?,?,?)`)
        .run(id, idempotencyKey, 'testnet', trustedCircleId, contractId, readiness.codeSha256.toLowerCase(),
          readiness.round, recipient, readiness.amountYocto, actor, now, now);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE constraint failed')) {
        const existing = this.db.prepare('SELECT * FROM payout_execution_plans WHERE idempotency_key = ? OR (contract_id = ? AND round_number = ?)')
          .get(idempotencyKey, contractId, readiness.round);
        if (existing) {
          const saved = rowToPlan(existing);
          if (saved.circleId !== trustedCircleId || saved.recipient !== recipient
              || saved.codeSha256 !== readiness.codeSha256.toLowerCase()
              || saved.amountYocto !== readiness.amountYocto) {
            throw new Error('Conflicting payout plan already exists for this contract round; reconcile it instead of replacing it');
          }
          return saved;
        }
      }
      throw error;
    }
    return this.get(id);
  }

  get(id) {
    return rowToPlan(this.db.prepare('SELECT * FROM payout_execution_plans WHERE id = ?').get(text(id, 'plan id')));
  }

  authorize(id, { actor, confirmation }) {
    const plan = this.get(id);
    if (!plan) throw new Error('Payout plan was not found');
    if (plan.state !== 'PREPARED') throw new Error(`Cannot authorize a payout in state ${plan.state}`);
    const authorizedBy = account(actor, 'authorization actor');
    if (authorizedBy === plan.preparedBy) throw new Error('A second, independently authenticated operator must authorize the payout');
    const expected = `AUTHORIZE TESTNET PAYOUT ${plan.contractId} ROUND ${plan.round}`;
    if (confirmation !== expected) throw new Error('Exact payout confirmation phrase does not match');
    this.db.prepare(`UPDATE payout_execution_plans SET state='AUTHORIZED',authorized_by=?,authorization_phrase=?,updated_at=?
      WHERE id=? AND state='PREPARED'`).run(authorizedBy, confirmation, this.clock(), plan.id);
    return this.get(id);
  }

  recordSubmitted(id, txHash) {
    const plan = this.get(id);
    if (!plan) throw new Error('Payout plan was not found');
    if (plan.state !== 'AUTHORIZED') throw new Error(`Cannot record submission in state ${plan.state}`);
    const hash = text(txHash, 'transaction hash');
    if (!TX_RE.test(hash)) throw new Error('Transaction hash format is invalid');
    this.db.prepare(`UPDATE payout_execution_plans SET state='SUBMITTED',tx_hash=?,updated_at=? WHERE id=? AND state='AUTHORIZED'`)
      .run(hash, this.clock(), plan.id);
    return this.get(id);
  }

  recordUnknown(id, reason, txHash = null) {
    const plan = this.get(id);
    if (!plan) throw new Error('Payout plan was not found');
    if (!['AUTHORIZED', 'SUBMITTED'].includes(plan.state)) throw new Error(`Cannot mark payout unknown in state ${plan.state}`);
    let hash = plan.txHash;
    if (txHash !== null && txHash !== undefined) {
      hash = text(txHash, 'uncertain transaction hash');
      if (!TX_RE.test(hash)) throw new Error('Transaction hash format is invalid');
      if (plan.txHash && plan.txHash !== hash) throw new Error('Uncertain transaction hash conflicts with the recorded hash');
    }
    this.db.prepare(`UPDATE payout_execution_plans SET state='UNKNOWN',tx_hash=?,failure_reason=?,updated_at=? WHERE id=? AND state=?`)
      .run(hash, text(reason, 'uncertain submission reason'), this.clock(), plan.id, plan.state);
    return this.get(id);
  }

  recordFinalized(id, { txHash, finalityVerified, outcome, evidenceReference }) {
    const plan = this.get(id);
    if (!plan) throw new Error('Payout plan was not found');
    if (!['SUBMITTED', 'UNKNOWN'].includes(plan.state)) throw new Error(`Cannot finalize payout in state ${plan.state}`);
    if (plan.txHash && plan.txHash !== txHash) throw new Error('Finalized transaction hash does not match the recorded submission');
    if (finalityVerified !== true || outcome !== 'SUCCESS') throw new Error('Independently verified successful finality evidence is required');
    const reference = text(evidenceReference, 'finality evidence reference');
    const hash = text(txHash, 'transaction hash');
    if (!TX_RE.test(hash)) throw new Error('Transaction hash format is invalid');
    const evidence = JSON.stringify({ txHash: hash, outcome, evidenceReference: reference, verifiedAt: this.clock() });
    this.db.prepare(`UPDATE payout_execution_plans SET state='FINALIZED',tx_hash=?,finality_evidence=?,failure_reason=NULL,updated_at=?
      WHERE id=? AND state=?`).run(hash, evidence, this.clock(), plan.id, plan.state);
    return this.get(id);
  }

  recordDefinitiveFailure(id, { failureConfirmed, reason }) {
    const plan = this.get(id);
    if (!plan) throw new Error('Payout plan was not found');
    if (!['AUTHORIZED', 'SUBMITTED', 'UNKNOWN'].includes(plan.state)) throw new Error(`Cannot fail payout in state ${plan.state}`);
    if (failureConfirmed !== true) throw new Error('A definitive, independently verified failure is required');
    this.db.prepare(`UPDATE payout_execution_plans SET state='FAILED',failure_reason=?,updated_at=? WHERE id=? AND state=?`)
      .run(text(reason, 'failure reason'), this.clock(), plan.id, plan.state);
    return this.get(id);
  }

  close() { this.db.close(); }
}
