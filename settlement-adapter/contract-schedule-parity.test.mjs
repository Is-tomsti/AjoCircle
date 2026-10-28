import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCircleSchedule } from './contract-schedule-parity.mjs';

const local = {
  contractId: 'ajo-demo.testnet', mode: 'PROTECTED_PUBLIC',
  members: ['alice.testnet', 'bob.testnet'], contributionAmount: '1000000000000000000000000',
  payoutOrder: ['alice.testnet', 'bob.testnet'], treasurerAgent: 'treasurer.testnet',
  currentRound: 0, roundDeadlineMs: 1800000000000,
  rounds: [
    { round: 0, contributionAmount: '1000000000000000000000000', deadlineMs: 1800000000000 },
    { round: 1, contributionAmount: '1000000000000000000000000', deadlineMs: 1800000003000 },
  ],
};
const onChain = {
  ...local, mode: 'ProtectedPublic', codeSha256: '164aa0f57e25a9b7a333f5c9e20ee3e7e1b8b09d26bbe54581d4a52e1ccdeaa0',
  roundDeadline: '1800000000000000000', rounds: [
    { round: 0, contributionAmount: '1000000000000000000000000', deadlineNs: '1800000000000000000' },
    { round: 1, contributionAmount: '1000000000000000000000000', deadlineNs: '1800000003000000000' },
  ],
  verified: true, network: 'testnet', circleCompleted: false, payoutPending: false,
  payoutComplete: false, currentRecipient: 'alice.testnet',
};

test('exact full schedule and approved contract evidence pass', () => {
  const result = compareCircleSchedule({ local, onChain });
  assert.equal(result.matches, true);
  assert.equal(result.quoteReady, true);
  assert.deepEqual(result.mismatches, []);
});

test('member, contribution, payout and treasurer mismatches fail closed', () => {
  const result = compareCircleSchedule({ local, onChain: {
    ...onChain, members: ['bob.testnet', 'alice.testnet'], contributionAmount: '7',
    payoutOrder: ['bob.testnet', 'alice.testnet'], treasurerAgent: 'other.testnet', currentRecipient: 'bob.testnet',
  } });
  assert.equal(result.quoteReady, false);
  assert.equal(result.mismatches.length, 5);
});

test('contract ID, code hash and mode mismatches fail closed', () => {
  for (const patch of [
    { contractId: 'other.testnet' }, { codeSha256: '0'.repeat(64) }, { mode: 'Private' },
  ]) assert.equal(compareCircleSchedule({ local, onChain: { ...onChain, ...patch } }).quoteReady, false);
});

test('any future-round deadline mismatch fails closed', () => {
  const alteredRounds = onChain.rounds.map(round => ({ ...round }));
  alteredRounds[1].deadlineNs = '1800000004000000000';
  assert.equal(compareCircleSchedule({ local, onChain: { ...onChain, rounds: alteredRounds } }).quoteReady, false);
});

test('missing full round schedule fails closed', () => {
  const { rounds, ...withoutSchedule } = onChain;
  assert.equal(compareCircleSchedule({ local, onChain: withoutSchedule }).quoteReady, false);
  assert.equal(compareCircleSchedule({ local: { ...local, rounds: undefined }, onChain }).quoteReady, false);
});

test('deadline mismatch and unrecorded sub-millisecond precision fail closed', () => {
  assert.equal(compareCircleSchedule({ local, onChain: { ...onChain, roundDeadline: '1800000000001000000' } }).quoteReady, false);
  assert.equal(compareCircleSchedule({ local, onChain: { ...onChain, roundDeadline: '1800000000000000001' } }).quoteReady, false);
});

test('exact nanosecond deadlines pass parity when persisted without precision loss', () => {
  const exactDeadlineNs = '1800000000000000001';
  const exactLocal = {
    ...local,
    roundDeadlineNs: exactDeadlineNs,
    rounds: local.rounds.map((round, index) => index === 0
      ? { ...round, deadlineNs: exactDeadlineNs }
      : round),
  };
  const exactOnChain = {
    ...onChain,
    roundDeadline: exactDeadlineNs,
    rounds: onChain.rounds.map((round, index) => index === 0 ? { ...round, deadlineNs: exactDeadlineNs } : round),
  };
  assert.equal(compareCircleSchedule({ local: exactLocal, onChain: exactOnChain }).quoteReady, true);
});

test('unverified, wrong network and terminal states fail closed', () => {
  for (const patch of [
    { verified: false }, { network: 'mainnet' }, { payoutPending: true },
    { circleCompleted: true }, { payoutComplete: true },
  ]) assert.equal(compareCircleSchedule({ local, onChain: { ...onChain, ...patch } }).quoteReady, false);
});

test('invalid recipient, member list and malformed schedule fail closed', () => {
  for (const patch of [
    { currentRecipient: 'mallory.testnet' }, { members: ['alice.testnet', 'alice.testnet'] },
    { payoutOrder: ['alice.testnet'] }, { roundDeadline: 'not-a-number' },
  ]) assert.equal(compareCircleSchedule({ local, onChain: { ...onChain, ...patch } }).quoteReady, false);
});

test('missing context fails closed', () => {
  assert.equal(compareCircleSchedule({ local: null, onChain }).quoteReady, false);
});
