import { DatabaseSync } from 'node:sqlite';
import { verifyExpectedDelivery } from './oneclick.mjs';

const REQUIRED_TEXT = ['intentId', 'depositAddress', 'circleId', 'memberId', 'destinationAsset', 'recipient'];
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function toIntent(row) {
  if (!row) return null;
  return Object.freeze({
    intentId: row.intent_id,
    depositAddress: row.deposit_address,
    circleId: row.circle_id,
    memberId: row.member_id,
    round: row.round_number,
    destinationAsset: row.destination_asset,
    recipient: row.recipient,
    minimumAmountOut: row.minimum_amount_out,
    status: row.status,
    amountOut: row.amount_out,
    destinationTxHashes: row.destination_tx_hashes ? JSON.parse(row.destination_tx_hashes) : [],
    depositMemo: row.deposit_memo ?? undefined,
    originAsset: row.origin_asset ?? undefined,
    amountIn: row.amount_in ?? undefined,
    quotedAmountOut: row.quoted_amount_out ?? undefined,
    quoteDeadline: row.quote_deadline ?? undefined,
    quoteSignature: row.quote_signature ?? undefined,
    quoteCorrelationId: row.quote_correlation_id ?? undefined,
    requiredContributionAmount: row.required_contribution_amount ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class SettlementStore {
  constructor({ path = ':memory:', clock = () => new Date().toISOString() } = {}) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_intents (
        intent_id TEXT PRIMARY KEY,
        deposit_address TEXT NOT NULL UNIQUE,
        circle_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        round_number INTEGER NOT NULL CHECK (round_number >= 0),
        destination_asset TEXT NOT NULL,
        recipient TEXT NOT NULL,
        minimum_amount_out TEXT NOT NULL CHECK (length(minimum_amount_out) > 0 AND minimum_amount_out NOT GLOB '*[^0-9]*'),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'VERIFIED_DELIVERY')),
        amount_out TEXT,
        destination_tx_hashes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_destination_transactions (
        tx_hash TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES pending_intents(intent_id),
        consumed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS consumed_transactions_by_intent
        ON consumed_destination_transactions(intent_id);
    `);
    ensureColumn(this.db, 'pending_intents', 'deposit_memo', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'origin_asset', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'amount_in', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'quoted_amount_out', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'quote_deadline', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'quote_signature', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'quote_correlation_id', 'TEXT');
    ensureColumn(this.db, 'pending_intents', 'required_contribution_amount', 'TEXT');
  }

  createPendingIntent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Intent must be an object');
    const record = {};
    for (const field of REQUIRED_TEXT) record[field] = requireText(input[field], field);
    if (!Number.isSafeInteger(input.round) || input.round < 0) throw new Error('round must be a non-negative safe integer');
    if (typeof input.minimumAmountOut !== 'string' || !AMOUNT_RE.test(input.minimumAmountOut)) {
      throw new Error('minimumAmountOut must be an integer base-unit string');
    }
    const optional = field => input[field] === undefined ? null : requireText(input[field], field);
    const amountIn = optional('amountIn');
    const quotedAmountOut = optional('quotedAmountOut');
    if (amountIn !== null && (!AMOUNT_RE.test(amountIn) || BigInt(amountIn) <= 0n)) throw new Error('amountIn must be a positive base-unit integer string');
    if (quotedAmountOut !== null && (!AMOUNT_RE.test(quotedAmountOut) || BigInt(quotedAmountOut) <= 0n)) throw new Error('quotedAmountOut must be a positive base-unit integer string');
    const now = this.clock();
    this.db.prepare(`
      INSERT INTO pending_intents
      (intent_id, deposit_address, circle_id, member_id, round_number, destination_asset,
       recipient, minimum_amount_out, status, created_at, updated_at, deposit_memo, origin_asset,
       amount_in, quoted_amount_out, quote_deadline, quote_signature, quote_correlation_id, required_contribution_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.intentId, record.depositAddress, record.circleId, record.memberId, input.round,
      record.destinationAsset, record.recipient, input.minimumAmountOut, now, now, optional('depositMemo'),
      optional('originAsset'), amountIn, quotedAmountOut, optional('quoteDeadline'),
      optional('quoteSignature'), optional('quoteCorrelationId'), optional('requiredContributionAmount'));
    return this.getIntent(record.intentId);
  }

  getIntent(intentId) {
    const row = this.db.prepare(`
      SELECT i.*, COALESCE(
        (SELECT json_group_array(tx_hash) FROM
          (SELECT tx_hash FROM consumed_destination_transactions c
           WHERE c.intent_id = i.intent_id ORDER BY tx_hash)), NULL
      ) AS destination_tx_hashes
      FROM pending_intents i WHERE intent_id = ?
    `).get(requireText(intentId, 'intentId'));
    return toIntent(row);
  }

  claimVerifiedDelivery(intentId, observed) {
    const trustedId = requireText(intentId, 'intentId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM pending_intents WHERE intent_id = ?').get(trustedId);
      if (!row) throw new Error('Pending intent was not found');
      if (row.status !== 'PENDING') throw new Error(`Intent cannot be consumed from status ${row.status}`);
      const verified = verifyExpectedDelivery(observed, {
        depositAddress: row.deposit_address,
        destinationAsset: row.destination_asset,
        recipient: row.recipient,
        minimumAmountOut: row.minimum_amount_out,
      });
      const now = this.clock();
      const insertTx = this.db.prepare(
        'INSERT INTO consumed_destination_transactions (tx_hash, intent_id, consumed_at) VALUES (?, ?, ?)'
      );
      for (const hash of verified.destinationTxHashes) {
        insertTx.run(requireText(hash, 'destination transaction hash'), trustedId, now);
      }
      const update = this.db.prepare(`
        UPDATE pending_intents
        SET status = 'VERIFIED_DELIVERY', amount_out = ?, updated_at = ?
        WHERE intent_id = ? AND status = 'PENDING'
      `).run(verified.amountOut, now, trustedId);
      if (Number(update.changes) !== 1) throw new Error('Intent was already consumed');
      this.db.exec('COMMIT');
      return this.getIntent(trustedId);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
