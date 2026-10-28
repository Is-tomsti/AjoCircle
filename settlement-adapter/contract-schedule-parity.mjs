import { APPROVED_AJOCIRCLE_TESTNET_SHA256S } from './near-contract-verification.mjs';

const ACCOUNT_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validAccountList(value) {
  return Array.isArray(value) && value.length >= 2
    && value.every(account => typeof account === 'string' && ACCOUNT_RE.test(account))
    && new Set(value).size === value.length;
}

function positiveIntegerString(value) {
  return typeof value === 'string' && POSITIVE_INTEGER_RE.test(value);
}

function localDeadlineNs(round) {
  if (positiveIntegerString(round?.deadlineNs)) return round.deadlineNs;
  if (Number.isSafeInteger(round?.deadlineMs) && round.deadlineMs > 0) return String(BigInt(round.deadlineMs) * 1000000n);
  return null;
}

function validLocalRounds(rounds, memberCount, contributionAmount) {
  if (!Array.isArray(rounds) || rounds.length !== memberCount || rounds.length < 2) return false;
  let previousDeadline = 0n;
  return rounds.every((round, index) => {
    const deadlineNs = localDeadlineNs(round);
    if (!round || round.round !== index || round.contributionAmount !== contributionAmount
        || !deadlineNs) return false;
    const deadline = BigInt(deadlineNs);
    if (deadline <= previousDeadline) return false;
    if (Number.isSafeInteger(round.deadlineMs) && BigInt(round.deadlineMs) !== deadline / 1000000n) return false;
    previousDeadline = deadline;
    return true;
  });
}

function validOnChainRounds(rounds, memberCount, contributionAmount) {
  if (!Array.isArray(rounds) || rounds.length !== memberCount || rounds.length < 2) return false;
  let previousDeadline = 0n;
  return rounds.every((round, index) => {
    if (!round || round.round !== index || round.contributionAmount !== contributionAmount
        || !positiveIntegerString(round.deadlineNs)) return false;
    const deadline = BigInt(round.deadlineNs);
    if (deadline <= previousDeadline) return false;
    previousDeadline = deadline;
    return true;
  });
}

export function compareCircleSchedule({ local, onChain }) {
  const mismatches = [];
  const lifecycleBlockers = [];
  if (!local || typeof local !== 'object' || !onChain || typeof onChain !== 'object') {
    const missing = Object.freeze(['schedule context is missing']);
    return Object.freeze({
      matches: false, scheduleMatches: false, parityMatches: false, quoteReady: false,
      lifecycleEligible: false, lifecycleBlockers: missing,
      mismatches: missing, parityMismatches: missing,
    });
  }

  if (typeof local.contractId !== 'string' || !ACCOUNT_RE.test(local.contractId)
      || onChain.contractId !== local.contractId) mismatches.push('contract ID differs');
  if (typeof onChain.codeSha256 !== 'string' || !APPROVED_AJOCIRCLE_TESTNET_SHA256S.includes(onChain.codeSha256.toLowerCase())) mismatches.push('contract code hash is not approved');
  const expectedMode = local.mode === 'PROTECTED_PUBLIC' ? 'ProtectedPublic'
    : local.mode === 'PRIVATE_TRUSTED' ? 'Private' : null;
  if (!expectedMode || onChain.mode !== expectedMode) mismatches.push('contract mode differs');
  if (!validAccountList(local.members) || !validAccountList(onChain.members)
      || !sameList(local.members, onChain.members)) mismatches.push('member order differs');
  if (!positiveIntegerString(local.contributionAmount)
      || local.contributionAmount !== onChain.contributionAmount
      || !positiveIntegerString(onChain.contributionAmount)) mismatches.push('contribution amount differs');
  if (!validAccountList(local.payoutOrder) || !validAccountList(onChain.payoutOrder)
      || !sameList(local.payoutOrder, onChain.payoutOrder)) mismatches.push('payout order differs');
  if (typeof local.treasurerAgent !== 'string' || !ACCOUNT_RE.test(local.treasurerAgent)
      || local.treasurerAgent !== onChain.treasurerAgent) mismatches.push('treasurer account differs');

  const roundValid = Number.isSafeInteger(local.currentRound) && local.currentRound >= 0
    && Number.isSafeInteger(onChain.currentRound) && onChain.currentRound >= 0;
  if (!roundValid || local.currentRound !== onChain.currentRound) mismatches.push('current round differs');

  const localRoundsValid = validLocalRounds(local.rounds, local.members?.length, local.contributionAmount);
  const onChainRoundsValid = validOnChainRounds(onChain.rounds, onChain.members?.length, onChain.contributionAmount);
  if (!localRoundsValid || !onChainRoundsValid) {
    mismatches.push('full round schedule is missing or invalid');
  } else {
    for (let index = 0; index < local.rounds.length; index += 1) {
      if (BigInt(localDeadlineNs(local.rounds[index])) !== BigInt(onChain.rounds[index].deadlineNs)) {
        mismatches.push(`round ${index} deadline differs`);
      }
    }
    const expectedCurrentDeadlineNs = local.currentRound < local.rounds.length
      ? localDeadlineNs(local.rounds[local.currentRound]) : null;
    const localCurrentDeadlineNs = local.roundDeadlineNs ?? (Number.isSafeInteger(local.roundDeadlineMs)
      ? String(BigInt(local.roundDeadlineMs) * 1000000n) : null);
    if (roundValid && local.currentRound < local.rounds.length
        && (localCurrentDeadlineNs !== expectedCurrentDeadlineNs
          || String(onChain.roundDeadline) !== onChain.rounds[onChain.currentRound]?.deadlineNs)) {
      mismatches.push('current round deadline does not match the full schedule');
    }
  }

  if (onChain.verified !== true || onChain.network !== 'testnet') mismatches.push('contract verification is not trusted testnet evidence');
  if (onChain.circleCompleted !== false || onChain.payoutPending !== false || onChain.payoutComplete !== false) {
    lifecycleBlockers.push('contract lifecycle is not eligible for a new quote');
  }
  if (roundValid && validAccountList(onChain.payoutOrder)
      && onChain.payoutOrder[onChain.currentRound % onChain.payoutOrder.length] !== onChain.currentRecipient) {
    mismatches.push('current recipient does not match payout order');
  }

  const frozen = Object.freeze([...new Set(mismatches)]);
  const frozenLifecycle = Object.freeze([...new Set(lifecycleBlockers)]);
  const parityMatches = frozen.length === 0;
  const lifecycleEligible = frozenLifecycle.length === 0;
  const quoteReady = parityMatches && lifecycleEligible;
  return Object.freeze({
    matches: quoteReady,
    scheduleMatches: parityMatches,
    parityMatches,
    lifecycleEligible,
    lifecycleBlockers: frozenLifecycle,
    quoteReady,
    mismatches: Object.freeze([...frozen, ...frozenLifecycle]),
    parityMismatches: frozen,
  });
}
