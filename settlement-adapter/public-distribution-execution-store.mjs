import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const TX = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const HASH = /^[a-f0-9]{64}$/i;
const STATES = new Set(['PREPARED','AUTHORIZED','SUBMITTED','UNKNOWN','FINALIZED']);
const required = (v, n) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${n} is required`); return v.trim(); };
function map(row) {
  if (!row) return null;
  return Object.freeze({ id: row.id, circleId: row.circle_id, contractId: row.contract_id,
    network: row.network, codeSha256: row.code_sha256, round: row.round_number,
    preparedBy: row.prepared_by, authorizedBy: row.authorized_by, state: row.state,
    distributionPlan: JSON.parse(row.distribution_plan_json), totalYocto: row.total_yocto,
    txHashes: JSON.parse(row.tx_hashes_json), finalityEvidence: row.finality_evidence_json ? JSON.parse(row.finality_evidence_json) : null,
    failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at });
}

/** Durable, testnet-only dual-operator ledger. It never signs or submits transactions. */
export class PublicDistributionExecutionStore {
  constructor({ path = ':memory:', clock = () => new Date().toISOString() } = {}) {
    this.db = new DatabaseSync(path); this.clock = clock;
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS public_distribution_execution_plans (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, contract_id TEXT NOT NULL,
      network TEXT NOT NULL CHECK(network='testnet'), code_sha256 TEXT NOT NULL CHECK(length(code_sha256)=64),
      round_number INTEGER NOT NULL CHECK(round_number>=0), prepared_by TEXT NOT NULL,
      authorized_by TEXT, state TEXT NOT NULL CHECK(state IN ('PREPARED','AUTHORIZED','SUBMITTED','UNKNOWN','FINALIZED')),
      distribution_plan_json TEXT NOT NULL, total_yocto TEXT NOT NULL,
      tx_hashes_json TEXT NOT NULL DEFAULT '[]', finality_evidence_json TEXT, failure_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(contract_id, round_number)
    );`);
  }
  prepare({ circleId, preparedBy, contractId, codeSha256, round, plan, totalYocto, network }) {
    if (network !== 'testnet') throw new Error('Public distribution is testnet-only');
    if (!HASH.test(codeSha256 ?? '') || !Number.isSafeInteger(round) || round < 0) throw new Error('Verified code hash and round are required');
    const idCircle = required(circleId, 'circleId'), actor = required(preparedBy, 'preparedBy'), contract = required(contractId, 'contractId');
    if (!ACCOUNT.test(actor) || !ACCOUNT.test(contract)) throw new Error('Invalid account ID');
    if (!Array.isArray(plan) || plan.length < 2 || plan.some(x => !x || !ACCOUNT.test(x.member ?? '') || !/^[1-9]\d*$/.test(x.amountYocto ?? '')) || new Set(plan.map(x => x.member)).size !== plan.length) throw new Error('Verified per-member distribution plan is invalid');
    const sum = plan.reduce((n,x) => n + BigInt(x.amountYocto), 0n).toString();
    if (sum !== totalYocto) throw new Error('Distribution total does not equal the verified per-member plan');
    const existing = this.db.prepare('SELECT * FROM public_distribution_execution_plans WHERE contract_id=? AND round_number=?').get(contract, round);
    if (existing) {
      const saved = map(existing);
      if (saved.circleId !== idCircle || saved.codeSha256 !== codeSha256.toLowerCase() || saved.totalYocto !== sum || JSON.stringify(saved.distributionPlan) !== JSON.stringify(plan)) throw new Error('Conflicting distribution plan already exists; reconcile it instead of replacing it');
      return saved;
    }
    const now = this.clock(), id = randomUUID();
    this.db.prepare(`INSERT INTO public_distribution_execution_plans
      (id,circle_id,contract_id,network,code_sha256,round_number,prepared_by,state,distribution_plan_json,total_yocto,created_at,updated_at)
      VALUES (?,?,?,'testnet',?,?,?,'PREPARED',?,?,?,?)`).run(id,idCircle,contract,codeSha256.toLowerCase(),round,actor,JSON.stringify(plan),sum,now,now);
    return this.get(id);
  }
  get(id) {
    const plan = map(this.db.prepare(
      'SELECT * FROM public_distribution_execution_plans WHERE id=?'
    ).get(required(id, 'planId')));
    if (!plan) return null;
    const table = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='public_distribution_attempts'"
    ).get();
    let attempts = [];
    if (table) {
      const columns = this.db.prepare('PRAGMA table_info(public_distribution_attempts)').all().map(x => x.name);
      if (!columns.includes('outcome')) {
        this.db.exec("ALTER TABLE public_distribution_attempts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(outcome IN ('UNKNOWN','VERIFIED_SUCCESS','VERIFIED_FAILURE'));");
      }
      attempts = this.db.prepare(
        'SELECT tx_hash AS txHash, action, round_number AS round, recipient_index AS recipientIndex, recipient, recorded_at AS recordedAt, outcome FROM public_distribution_attempts WHERE plan_id=? ORDER BY id'
      ).all(plan.id);
    }
    return Object.freeze({ ...plan, attempts });
  }
  authorize(id, { actor, confirmation }) {
    const p = this.get(id); if (!p) throw new Error('Distribution plan not found');
    if (p.state !== 'PREPARED') throw new Error(`Cannot authorize plan in state ${p.state}`);
    const who = required(actor,'authorizing member'); if (!ACCOUNT.test(who) || who === p.preparedBy) throw new Error('A different authenticated member must authorize this distribution');
    const expected = `AUTHORIZE TESTNET DISTRIBUTION ${p.contractId} ROUND ${p.round} TOTAL ${p.totalYocto} YOCTO`;
    if (confirmation !== expected) throw new Error('Exact distribution authorization phrase does not match');
    this.db.prepare("UPDATE public_distribution_execution_plans SET state='AUTHORIZED',authorized_by=?,updated_at=? WHERE id=? AND state='PREPARED'").run(who,this.clock(),p.id);
    return this.get(id);
  }
  recordSubmitted(id, txHash) {
    const p=this.get(id); if (!p || !['AUTHORIZED','SUBMITTED','UNKNOWN'].includes(p.state)) throw new Error('Plan is not authorized for distribution submission');
    if (!TX.test(txHash ?? '')) throw new Error('Valid transaction hash is required');
    const hashes=[...p.txHashes]; if (hashes.includes(txHash)) return p; hashes.push(txHash);
    this.db.prepare("UPDATE public_distribution_execution_plans SET state='SUBMITTED',tx_hashes_json=?,failure_reason=NULL,updated_at=? WHERE id=?").run(JSON.stringify(hashes),this.clock(),p.id);
    return this.get(id);
  }
  recordAttempt(id, attempt) {
    const p = this.get(id);
    if (!p || !['AUTHORIZED', 'SUBMITTED', 'UNKNOWN'].includes(p.state)) {
      throw new Error('Plan is not in a state that permits recording an attempt');
    }
    if (!attempt || !TX.test(attempt.txHash ?? '')) {
      throw new Error('Valid transaction hash is required');
    }
    if (!['start', 'continue'].includes(attempt.action)) {
      throw new Error('Valid distribution action is required');
    }
    if (!Number.isSafeInteger(attempt.recipientIndex) || attempt.recipientIndex < 0) {
      throw new Error('Valid recipient index is required');
    }
    const now = this.clock();
    this.db.exec(`CREATE TABLE IF NOT EXISTS public_distribution_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES public_distribution_execution_plans(id),
      tx_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('start','continue')),
      round_number INTEGER NOT NULL,
      recipient_index INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(outcome IN ('UNKNOWN','VERIFIED_SUCCESS','VERIFIED_FAILURE')),
      UNIQUE(plan_id, tx_hash)
    );`);
    const attemptColumns = this.db.prepare('PRAGMA table_info(public_distribution_attempts)').all().map(x => x.name);
    if (!attemptColumns.includes('outcome')) this.db.exec("ALTER TABLE public_distribution_attempts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(outcome IN ('UNKNOWN','VERIFIED_SUCCESS','VERIFIED_FAILURE'));");
    this.db.prepare(`INSERT OR IGNORE INTO public_distribution_attempts
      (plan_id, tx_hash, action, round_number, recipient_index, recipient, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        p.id, attempt.txHash, attempt.action, p.round,
        attempt.recipientIndex, required(attempt.recipient, 'recipient'),
        required(attempt.recordedAt, 'recordedAt')
      );
    return this.get(id);
  }
  recordAttemptOutcome(id, txHash, outcome) {
    const p = this.get(id);
    if (!p || !['AUTHORIZED', 'SUBMITTED', 'UNKNOWN'].includes(p.state)) {
      throw new Error('Plan is not in a reconcilable state');
    }
    if (!TX.test(txHash ?? '')) throw new Error('Valid transaction hash is required');
    if (!['UNKNOWN', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE'].includes(outcome)) {
      throw new Error('Valid verified attempt outcome is required');
    }
    const current = this.db.prepare(
      'SELECT outcome FROM public_distribution_attempts WHERE plan_id=? AND tx_hash=?'
    ).get(p.id, txHash);
    if (!current) throw new Error('Recorded distribution attempt was not found');
    if (current.outcome !== 'UNKNOWN' && current.outcome !== outcome) {
      throw new Error('A verified distribution attempt outcome cannot be overwritten');
    }
    const result = this.db.prepare(
      "UPDATE public_distribution_attempts SET outcome=? WHERE plan_id=? AND tx_hash=? AND outcome='UNKNOWN'"
    ).run(outcome, p.id, txHash);
    if (Number(result.changes) !== 1 && current.outcome !== outcome) {
      throw new Error('Distribution attempt outcome changed concurrently; reload and reconcile');
    }
    return this.get(id);
  }
  resolveVerifiedFailure(id, txHash) {
    const p = this.get(id);
    if (!p || p.state !== 'UNKNOWN') throw new Error('Only an unknown plan can be reconciled from a verified failed attempt');
    const attempt = p.attempts.find(item => item.txHash === txHash);
    if (!attempt || attempt.outcome !== 'VERIFIED_FAILURE') throw new Error('A finalized failed transaction must be verified before resolving the plan');
    const nextState = attempt.action === 'start' ? 'AUTHORIZED' : 'SUBMITTED';
    this.db.prepare("UPDATE public_distribution_execution_plans SET state=?,failure_reason=NULL,updated_at=? WHERE id=? AND state='UNKNOWN'").run(nextState, this.clock(), p.id);
    return this.get(id);
  }
  recordUnknown(id, reason) {
    const p=this.get(id); if (!p || !['AUTHORIZED','SUBMITTED','UNKNOWN'].includes(p.state)) throw new Error('Cannot mark plan unknown in current state');
    this.db.prepare("UPDATE public_distribution_execution_plans SET state='UNKNOWN',failure_reason=?,updated_at=? WHERE id=?").run(required(reason,'reason'),this.clock(),p.id);
    return this.get(id);
  }
  finalize(id, { confirmed, evidence }) {
    const p=this.get(id); if (!p || !['SUBMITTED','UNKNOWN'].includes(p.state)) throw new Error('No submitted distribution plan to finalize');
    if (confirmed !== true || !Array.isArray(evidence) || evidence.length !== p.distributionPlan.length) throw new Error('Independent evidence for every recipient is required');
    if (p.txHashes.length !== p.distributionPlan.length
      || evidence.some((item, index) => !item
        || item.txHash !== p.txHashes[index]
        || item.outcome !== 'VERIFIED_SUCCESS'
        || item.methodName !== (index === 0 ? 'start_public_distribution' : 'continue_public_distribution'))) {
      throw new Error('Finalization requires matching transaction hashes and independently verified successful outcomes for every recipient');
    }
    const evidenceJson=JSON.stringify(evidence);
    this.db.prepare("UPDATE public_distribution_execution_plans SET state='FINALIZED',finality_evidence_json=?,failure_reason=NULL,updated_at=? WHERE id=?").run(evidenceJson,this.clock(),p.id);
    return this.get(id);
  }
  close() { this.db.close(); }
}
