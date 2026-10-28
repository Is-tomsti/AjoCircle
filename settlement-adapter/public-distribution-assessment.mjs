/**
 * Read-only public distribution assessment.
 * Never signs, submits, retries, or authorizes a transaction.
 */
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
const INTEGER_RE = /^(0|[1-9]\d*)$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function amountString(value, label, { positive = false } = {}) {
  requireState(typeof value === 'string' && (positive ? POSITIVE_INTEGER_RE : INTEGER_RE).test(value),
    `${label} is invalid`);
  return value;
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * @param {{ client: { view: (method: string, args?: object) => Promise<unknown> },
 *   binding: object, local: object, live: object }} input
 */
export async function inspectPublicDistribution({ client, binding, local, live } = {}) {
  requireState(client && typeof client.view === 'function', 'A read-only NEAR contract client is required');
  requireState(binding && local && live, 'Verified binding, local schedule, and live contract evidence are required');
  requireState(binding.network === 'testnet' && live.network === 'testnet', 'Public distribution assessment is testnet-only');
  requireState(live.verified === true, 'Live contract verification is not trusted');
  requireState(typeof binding.contractId === 'string' && binding.contractId === local.contractId
    && binding.contractId === live.contractId, 'Contract account does not match the verified binding');
  requireState(typeof binding.codeSha256 === 'string' && binding.codeSha256 === live.codeSha256,
    'Deployed contract code hash does not match the approved binding');
  requireState(local.mode === 'PROTECTED_PUBLIC' && live.mode === 'ProtectedPublic',
    'Only verified ProtectedPublic circles can use public distribution');
  requireState(binding.mode === 'ProtectedPublic', 'Persisted binding is not a ProtectedPublic contract');

  const names = [
    'get_members', 'get_payout_order', 'get_mode', 'get_contribution_amount',
    'get_treasurer_agent', 'get_round', 'get_round_deadlines', 'get_round_deadline',
    'is_circle_completed', 'is_payout_pending', 'is_payout_complete',
    'are_total_contributions_verified', 'get_protection_balance',
    'get_public_distribution_plan', 'get_public_distribution_index',
    'is_public_distribution_pending', 'is_public_distribution_complete',
  ];
  const state = Object.fromEntries(await Promise.all(names.map(async name => [name, await client.view(name)])));

  const members = local.members;
  requireState(Array.isArray(members) && members.length >= 2
    && members.every(member => typeof member === 'string' && ACCOUNT_RE.test(member))
    && new Set(members).size === members.length, 'Local member schedule is invalid');
  requireState(sameArray(state.get_members, members), 'On-chain member list differs from the local schedule');
  requireState(sameArray(state.get_payout_order, local.payoutOrder), 'On-chain payout order differs from the local schedule');
  requireState(state.get_mode === 'ProtectedPublic', 'On-chain mode is not ProtectedPublic');
  requireState(state.get_treasurer_agent === binding.contractId
    && local.treasurerAgent === binding.contractId, 'Treasurer account does not match the contract binding');

  const contributionAmount = amountString(state.get_contribution_amount, 'On-chain contribution amount', { positive: true });
  requireState(contributionAmount === local.contributionAmount, 'Contribution amount differs from the local schedule');

  const localRounds = local.rounds;
  const onChainDeadlines = state.get_round_deadlines;
  requireState(Array.isArray(localRounds) && localRounds.length === members.length,
    'Local full round schedule is missing');
  requireState(Array.isArray(onChainDeadlines) && onChainDeadlines.length === localRounds.length,
    'On-chain full round schedule is missing');
  const localDeadlines = localRounds.map((round, index) => {
    requireState(round && round.round === index, `Local round ${index} is invalid`);
    const deadline = round.deadlineNs ?? (Number.isSafeInteger(round.deadlineMs) ? String(BigInt(round.deadlineMs) * 1000000n) : null);
    amountString(deadline, `Local round ${index} deadline`, { positive: true });
    requireState(round.contributionAmount === contributionAmount, `Local round ${index} contribution amount differs`);
    return deadline;
  });
  const chainDeadlines = onChainDeadlines.map((value, index) => amountString(value, `On-chain deadline ${index}`, { positive: true }));
  requireState(sameArray(chainDeadlines, localDeadlines), 'On-chain deadlines differ from the local schedule');
  requireState(Number.isSafeInteger(state.get_round) && state.get_round === localRounds.length - 1,
    'The final scheduled public round has not been reached');
  requireState(state.get_round_deadline === chainDeadlines[state.get_round],
    'Current round deadline differs from the final scheduled deadline');

  requireState(state.is_circle_completed === true, 'Every public round must complete before distribution');
  requireState(state.is_payout_pending === false, 'A legacy payout is still pending');
  requireState(state.is_payout_complete === true, 'The final public round has not been marked complete');
  requireState(state.are_total_contributions_verified === true, 'Lifetime contribution totals are unverified');
  requireState(amountString(state.get_protection_balance, 'Protection balance') === '0',
    'Public protection obligations must be resolved before distribution');

  const totals = new Map();
  for (const member of members) {
    const total = await client.view('get_total_contribution', { member });
    amountString(total, `Verified lifetime contributions for ${member}`, { positive: true });
    const reserve = await client.view('get_reserve_share', { funder: member });
    requireState(amountString(reserve, `Reserve share for ${member}`) === '0',
      `Reserve-funder obligation remains for ${member}`);
    const guarantee = await client.view('get_guarantee', { member });
    if (guarantee !== null) {
      requireState(guarantee && typeof guarantee === 'object'
        && Object.hasOwn(guarantee, 'locked_amount')
        && String(guarantee.locked_amount) === '0',
      `Guarantee collateral remains unresolved for ${member}`);
    }
    totals.set(member, total);
  }

  const expectedMembers = [...members].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const plan = state.get_public_distribution_plan;
  requireState(Array.isArray(plan), 'On-chain public distribution plan is invalid');
  const index = state.get_public_distribution_index;
  requireState(Number.isSafeInteger(index) && index >= 0 && index <= plan.length,
    'On-chain public distribution index is invalid');
  requireState(typeof state.is_public_distribution_pending === 'boolean'
    && typeof state.is_public_distribution_complete === 'boolean',
    'Public distribution lifecycle flags are invalid');
  requireState(!(state.is_public_distribution_pending && state.is_public_distribution_complete),
    'Distribution cannot be pending and complete simultaneously');

  if (plan.length === 0) {
    requireState(index === 0 && state.is_public_distribution_pending === false
      && state.is_public_distribution_complete === false,
    'Empty distribution plan has inconsistent lifecycle state');
    return Object.freeze({
      status: 'READY_TO_START',
      plan: Object.freeze([]),
      index: 0,
      pending: false,
      complete: false,
      verifiedTotals: Object.freeze(Object.fromEntries(totals)),
      transactionSubmitted: false,
    });
  }

  requireState(plan.length === expectedMembers.length, 'Distribution plan does not contain every member');
  const parsedPlan = plan.map((entry, i) => {
    requireState(Array.isArray(entry) && entry.length === 2, `Distribution plan entry ${i} is invalid`);
    const [member, amount] = entry;
    requireState(member === expectedMembers[i], 'Distribution plan recipient order is not deterministic');
    amountString(amount, `Distribution plan amount for ${member}`, { positive: true });
    requireState(amount === totals.get(member), `Distribution amount for ${member} differs from verified lifetime contributions`);
    return Object.freeze({ member, amountYocto: amount });
  });
  requireState(!state.is_public_distribution_complete || (!state.is_public_distribution_pending && index === plan.length),
    'Completed distribution has inconsistent index or pending state');
  requireState(state.is_public_distribution_complete || index < plan.length,
    'Incomplete distribution index is outside the plan');

  const status = state.is_public_distribution_complete ? 'COMPLETE'
    : state.is_public_distribution_pending ? 'TRANSFER_PENDING' : 'RETRY_AVAILABLE';
  return Object.freeze({
    status,
    plan: Object.freeze(parsedPlan),
    index,
    pending: state.is_public_distribution_pending,
    complete: state.is_public_distribution_complete,
    verifiedTotals: Object.freeze(Object.fromEntries(totals)),
    transactionSubmitted: false,
  });
}
