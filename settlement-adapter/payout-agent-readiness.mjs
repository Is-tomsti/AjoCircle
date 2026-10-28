/**
 * Read-only payout readiness evaluator for the AjoCircle NEAR contract.
 * This module never signs, submits, or retries transactions.
 */
const YOCTO_PER_NEAR = 10n ** 24n;

function required(condition, message) {
  if (!condition) throw new Error(message);
}
function account(value, label) {
  required(typeof value === 'string' && /^[a-z0-9._-]+$/.test(value) && value.length >= 2 && value.length <= 64, `${label} is invalid`);
  return value;
}
function integer(value, label) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  required(/^(0|[1-9]\d*)$/.test(text), `${label} is invalid`);
  return BigInt(text);
}
function uniqueAccounts(values, label) {
  required(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  const parsed = values.map((value) => account(value, label));
  required(new Set(parsed).size === parsed.length, `${label} contains duplicates`);
  return parsed;
}

/**
 * @param {{view: (method: string, args?: object) => Promise<unknown>}} client read-only contract client
 * @param {{contractId: string, network: string, bindingVerified: boolean, nowMs?: number}} options
 */
export async function inspectPayoutReadiness(client, { contractId, network, bindingVerified, nowMs = Date.now() } = {}) {
  required(client && typeof client.view === 'function', 'A read-only contract client is required');
  account(contractId, 'Contract account ID');
  required(network === 'testnet', 'Payout readiness is restricted to NEAR testnet');
  required(bindingVerified === true, 'Approved contract binding must be verified before payout readiness can be evaluated');
  required(Number.isFinite(nowMs) && nowMs >= 0, 'Current time is invalid');

  const names = [
    'get_round', 'get_round_deadline', 'get_round_deadlines', 'get_members', 'get_payout_order',
    'get_current_recipient', 'get_contribution_amount', 'get_contribution_count', 'get_mode',
    'get_required_protection', 'get_protection_balance', 'get_treasurer_agent',
    'is_payout_pending', 'is_payout_complete', 'is_circle_completed',
  ];
  const values = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await client.view(name)])));
  const round = values.get_round;
  required(Number.isSafeInteger(round) && round >= 0, 'Contract round is invalid');
  const members = uniqueAccounts(values.get_members, 'Contract members');
  const payoutOrder = uniqueAccounts(values.get_payout_order, 'Payout order');
  required(members.length === payoutOrder.length && members.every((member) => payoutOrder.includes(member)), 'Payout order does not exactly match the member set');
  required(round < payoutOrder.length, 'Current round is outside the payout schedule');
  required(values.get_current_recipient === payoutOrder[round], 'Current recipient does not match the configured payout order');
  required(values.get_treasurer_agent === contractId, 'Configured treasurer is not this designated contract account');
  required(values.is_payout_pending === false && values.is_payout_complete === false, 'A payout is pending or already complete for this round');
  required(values.is_circle_completed === false, 'Circle is already completed');
  required(values.get_mode === 'Private' || values.get_mode === 'ProtectedPublic', 'Contract mode is invalid');

  const deadlineNs = integer(values.get_round_deadline, 'Round deadline');
  const schedule = values.get_round_deadlines;
  required(Array.isArray(schedule) && schedule.length === members.length, 'Full round schedule is missing or invalid');
  const parsedSchedule = schedule.map((deadline, index) => integer(deadline, `Round deadline ${index}`));
  required(parsedSchedule.every((deadline, index) => index === 0 || deadline > parsedSchedule[index - 1]), 'Round deadlines are not strictly increasing');
  required(parsedSchedule[round] === deadlineNs, 'Active round deadline does not match the full schedule');

  const amount = integer(values.get_contribution_amount, 'Contribution amount');
  required(amount > 0n, 'Contribution amount must be positive');
  const contributionCount = values.get_contribution_count;
  required(Number.isSafeInteger(contributionCount) && contributionCount >= 0 && contributionCount <= members.length, 'Contribution count is invalid');
  const requiredProtection = integer(values.get_required_protection, 'Required protection');
  const protectionBalance = integer(values.get_protection_balance, 'Protection balance');
  const missingCount = members.length - contributionCount;
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  const deadlinePassed = nowNs >= deadlineNs;
  let status = 'ready';
  let reason = 'All members have contributed; contract conditions permit payout initiation.';
  if (missingCount > 0) {
    if (values.get_mode === 'Private') {
      status = 'blocked'; reason = 'Private circles require every member to contribute before payout.';
    } else if (!deadlinePassed) {
      status = 'waiting'; reason = 'Protected shortfall cannot be used before the contribution deadline.';
    } else if (protectionBalance < amount * BigInt(missingCount) || requiredProtection > protectionBalance) {
      status = 'blocked'; reason = 'Protection reserve is insufficient to cover the exact contribution shortfall.';
    } else {
      status = 'ready'; reason = 'Deadline passed and verified protection can cover the missing contributions.';
    }
  }
  return Object.freeze({
    mode: values.get_mode, contractId, network, round, recipient: values.get_current_recipient,
    memberCount: members.length, contributionCount, missingCount,
    contributionYocto: amount.toString(), potYocto: (amount * BigInt(members.length)).toString(),
    deadlineNs: deadlineNs.toString(), deadlinePassed,
    requiredProtectionYocto: requiredProtection.toString(), protectionBalanceYocto: protectionBalance.toString(),
    status, reason, transactionSubmitted: false,
  });
}

export function formatYoctoNear(value) {
  const amount = integer(value, 'yoctoNEAR amount');
  const whole = amount / YOCTO_PER_NEAR;
  const fraction = (amount % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} NEAR` : `${whole} NEAR`;
}
