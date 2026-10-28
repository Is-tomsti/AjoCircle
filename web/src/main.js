import { NearConnector } from '@hot-labs/near-connect';
import './style.css';

const API_BASE = (import.meta.env.VITE_AJO_API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN_KEY = 'ajoCircle.testnet.sessionToken';
const ACCOUNT_KEY = 'ajoCircle.testnet.accountId';
const WALLET_KEY = 'ajoCircle.testnet.walletName';
const EXPIRY_KEY = 'ajoCircle.testnet.expiresAt';
const CHALLENGE_KEY = 'ajoCircle.testnet.pendingChallenge';

const connectButton = document.querySelector('#connect-button');
const logoutButton = document.querySelector('#logout-button');
const verifySessionButton = document.querySelector('#verify-session-button');
const sessionResult = document.querySelector('#session-result');
const quoteButton = document.querySelector('#quote-button');
const statusNode = document.querySelector('#status');
const accountCard = document.querySelector('#account-card');
const accountNode = document.querySelector('#account-id');
const quoteForm = document.querySelector('#quote-form');
const quoteResult = document.querySelector('#quote-result');
const originAssetSelect = quoteForm.elements.originAsset;
const contributionStatusForm = document.querySelector('#contribution-status-form');
const contributionStatusButton = document.querySelector('#contribution-status-button');
const contributionStatusResult = document.querySelector('#contribution-status-result');
const nativeEvidenceStatusForm = document.querySelector('#native-evidence-status-form');
const nativeEvidenceStatusButton = document.querySelector('#native-evidence-status-button');
const nativeEvidenceStatusResult = document.querySelector('#native-evidence-status-result');
const contributionEvidenceForm = document.querySelector('#contribution-evidence-form');
const contributionEvidenceButton = document.querySelector('#contribution-evidence-button');
const contributionEvidenceResult = document.querySelector('#contribution-evidence-result');
const nativeContributionForm = document.querySelector('#native-contribution-form');
const nativeContributionButton = document.querySelector('#native-contribution-button');
const nativeContributionResult = document.querySelector('#native-contribution-result');
const circleCreateSection = document.querySelector('#circle-create-section');
const circleCreateForm = document.querySelector('#circle-create-form');
const createCircleButton = document.querySelector('#create-circle-button');
const circleCreateResult = document.querySelector('#circle-create-result');
const contractVerifyForm = document.querySelector('#contract-verify-form');
const verifyContractButton = document.querySelector('#verify-contract-button');
const contractVerificationResult = document.querySelector('#contract-verification-result');
const scheduleParityForm = document.querySelector('#schedule-parity-configure-form');
const configureParityButton = document.querySelector('#configure-parity-button');
const scheduleParityResult = document.querySelector('#schedule-parity-result');
const circlePolicySection = document.querySelector('#circle-policy-section');
const cycleConfigureForm = document.querySelector('#cycle-configure-form');
const configureCycleButton = document.querySelector('#configure-cycle-button');
const importExistingCycleButton = document.querySelector('#import-existing-cycle-button');
const importCycleCircleId = document.querySelector('#import-cycle-circle-id');
const circleInvitationSection = document.querySelector('#circle-invitation-section');
const policyPreviewForm = document.querySelector('#policy-preview-form');
const policyPreviewButton = document.querySelector('#policy-preview-button');
const policyPreviewCard = document.querySelector('#policy-preview-card');
const policyModeTitle = document.querySelector('#policy-mode-title');
const policyVersionLabel = document.querySelector('#policy-version-label');
const policyDescription = document.querySelector('#policy-description');
const policyRuleList = document.querySelector('#policy-rule-list');
const policyAcceptance = document.querySelector('#policy-acceptance');
const joinCircleButton = document.querySelector('#join-circle-button');
const policyResult = document.querySelector('#policy-result');
const invitationForm = document.querySelector('#invitation-form');
const createInvitationButton = document.querySelector('#create-invitation-button');
const invitationResult = document.querySelector('#invitation-result');
const invitationLink = document.querySelector('#invitation-link');
const copyInvitationButton = document.querySelector('#copy-invitation-button');
const revokeInvitationButton = document.querySelector('#revoke-invitation-button');
const cycleStatusButton = document.querySelector('#cycle-status-button');
const cycleStartButton = document.querySelector('#cycle-start-button');
const cycleStatusLabel = document.querySelector('#cycle-status-label');
const cycleResult = document.querySelector('#cycle-result');
const payoutReadinessForm = document.querySelector('#payout-readiness-form');
const payoutReadinessButton = document.querySelector('#payout-readiness-button');
const payoutReadinessResult = document.querySelector('#payout-readiness-result');
const publicDistributionForm = document.querySelector('#public-distribution-assessment-form');
const publicDistributionButton = document.querySelector('#public-distribution-assessment-button');
const publicDistributionResult = document.querySelector('#public-distribution-assessment-result');
const publicDistributionPrepareForm = document.querySelector('#public-distribution-prepare-form');
const publicDistributionPrepareButton = document.querySelector('#public-distribution-prepare-button');
const publicDistributionExecutionResult = document.querySelector('#public-distribution-execution-result');
const publicDistributionAuthorizeForm = document.querySelector('#public-distribution-authorize-form');
const publicDistributionAuthorizeButton = document.querySelector('#public-distribution-authorize-button');
const publicDistributionStartForm = document.querySelector('#public-distribution-start-form');
const publicDistributionStartButton = document.querySelector('#public-distribution-start-button');
const publicDistributionContinueForm = document.querySelector('#public-distribution-continue-form');
const publicDistributionContinueButton = document.querySelector('#public-distribution-continue-button');
const publicDistributionStatusForm = document.querySelector('#public-distribution-status-form');
const publicDistributionStatusButton = document.querySelector('#public-distribution-status-button');
const publicDistributionExecutionStatus = document.querySelector('#public-distribution-execution-status');
const preparePayoutPlanButton = document.querySelector('#prepare-payout-plan-button');
const payoutPlanResult = document.querySelector('#payout-plan-result');
const payoutPlanStatusForm = document.querySelector('#payout-plan-status-form');
const payoutPlanStatusButton = document.querySelector('#payout-plan-status-button');
const payoutPlanStatusResult = document.querySelector('#payout-plan-status-result');
const payoutPlanAuthorizeForm = document.querySelector('#payout-plan-authorize-form');
const authorizePayoutPlanButton = document.querySelector('#authorize-payout-plan-button');
const payoutPlanAuthorizeResult = document.querySelector('#payout-plan-authorize-result');
const payoutPlanSubmitForm = document.querySelector('#payout-plan-submit-form');
const submitPayoutPlanButton = document.querySelector('#submit-payout-plan-button');
const payoutPlanSubmitResult = document.querySelector('#payout-plan-submit-result');
const payoutPlanFinalizeForm = document.querySelector('#payout-plan-finalize-form');
const finalizePayoutPlanButton = document.querySelector('#finalize-payout-plan-button');
const payoutPlanFinalizeResult = document.querySelector('#payout-plan-finalize-result');
let currentCycle = null;
let currentPolicy = null;
let currentPublicDistributionPlan = null;
const verifiedCircleLifecycle = new Map();

function applyVerifiedCircleLifecycle(circleId, lifecycle) {
  if (typeof circleId !== 'string' || !circleId.trim()) return;
  const key = circleId.trim();
  const verifiedAt = typeof lifecycle?.verifiedAt === 'string' ? lifecycle.verifiedAt : '';
  const verifiedAtMs = Date.parse(verifiedAt);
  const ageMs = Date.now() - verifiedAtMs;
  if (lifecycle?.verified !== true || !Number.isFinite(verifiedAtMs)
      || ageMs < 0 || ageMs > 60_000) {
    // Never convert missing, malformed, future, or stale evidence into a fresh snapshot.
    verifiedCircleLifecycle.delete(key);
    refreshQuoteAvailability();
    return;
  }
  const snapshot = Object.freeze({
    circleCompleted: lifecycle.circleCompleted === true,
    payoutPending: lifecycle.payoutPending === true,
    payoutComplete: lifecycle.payoutComplete === true,
    verifiedAt,
  });
  verifiedCircleLifecycle.set(key, snapshot);
  refreshQuoteAvailability();
}

function refreshQuoteAvailability() {
  const circleId = String(quoteForm.elements.circleId.value ?? '').trim();
  const lifecycle = verifiedCircleLifecycle.get(circleId);
  const verifiedAtMs = Date.parse(lifecycle?.verifiedAt ?? '');
  const ageMs = Date.now() - verifiedAtMs;
  const fresh = lifecycle && Number.isFinite(verifiedAtMs) && ageMs >= 0 && ageMs <= 60_000;
  const terminalOrPending = lifecycle?.circleCompleted === true
    || lifecycle?.payoutPending === true || lifecycle?.payoutComplete === true;
  quoteButton.disabled = !getSession() || !fresh || terminalOrPending;
  if (!circleId || !getSession()) return;
  if (!fresh) {
    quoteResult.classList.remove('hidden');
    quoteResult.textContent = JSON.stringify({
      status: 'FRESH_VERIFICATION_REQUIRED', circleId,
      message: 'Verify this circle against finalized NEAR testnet state. Quote previews remain disabled until a fresh lifecycle check succeeds.',
    }, null, 2);
    return;
  }
  if (lifecycle?.circleCompleted) {
    quoteResult.classList.remove('hidden');
    quoteResult.textContent = JSON.stringify({
      status: 'CIRCLE_COMPLETED', circleId,
      payoutPending: lifecycle.payoutPending,
      payoutComplete: lifecycle.payoutComplete,
      circleCompleted: true,
      verifiedAt: lifecycle.verifiedAt,
      message: 'This circle is complete on-chain. Further quote previews are disabled; no contribution is required or permitted for this completed circle.',
    }, null, 2);
    setStatus('This circle is completed on NEAR testnet. Quote previews are disabled.', 'success');
  } else if (terminalOrPending) {
    quoteResult.classList.remove('hidden');
    quoteResult.textContent = JSON.stringify({
      status: lifecycle.payoutPending ? 'PAYOUT_PENDING' : 'PAYOUT_COMPLETE', circleId,
      verifiedAt: lifecycle.verifiedAt,
      message: 'This round is settling or already paid. Refresh the contract lifecycle before requesting another quote.',
    }, null, 2);
  }
}
let currentInviteToken = null;
let pendingInviteLoaded = false;
let signingFlowActive = false;
let handlingSignature = false;
let connector;
let signatureTimeout;

function setStatus(message, kind = 'info') {
  statusNode.textContent = message;
  statusNode.className = `status ${kind}`;
}
function getSession() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const accountId = sessionStorage.getItem(ACCOUNT_KEY);
  const walletName = sessionStorage.getItem(WALLET_KEY) ?? 'Connected wallet';
  const expiresAt = sessionStorage.getItem(EXPIRY_KEY);
  if (!token || !accountId || !expiresAt || Date.parse(expiresAt) <= Date.now()) {
    clearSession();
    return null;
  }
  return { token, accountId, walletName, expiresAt };
}
function clearSession() {
  // Lifecycle evidence is session-scoped in the UI; never reuse it after logout or expiry.
  verifiedCircleLifecycle.clear();
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ACCOUNT_KEY);
  sessionStorage.removeItem(WALLET_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
  accountCard.classList.add('hidden');
  circleCreateSection.classList.add('hidden');
  circleCreateResult.classList.add('hidden');
  circlePolicySection.classList.add('hidden');
  circleInvitationSection.classList.add('hidden');
  policyPreviewCard.classList.add('hidden');
  policyResult.classList.add('hidden');
  cycleResult.classList.add('hidden');
  cycleStatusLabel.textContent = 'Not checked';
  cycleStartButton.disabled = true;
  currentCycle = null;
  invitationResult.classList.add('hidden');
  policyAcceptance.checked = false;
  joinCircleButton.disabled = true;
  invitationLink.value = '';
  revokeInvitationButton.disabled = false;
  revokeInvitationButton.textContent = 'Revoke this invitation';
  currentPolicy = null;
  currentInviteToken = null;
  quoteButton.disabled = true;
  contributionStatusButton.disabled = true;
  contributionEvidenceButton.disabled = true;
  nativeEvidenceStatusButton.disabled = false;
  nativeContributionButton.disabled = true;
  preparePayoutPlanButton.disabled = true;
  payoutPlanStatusButton.disabled = true;
  authorizePayoutPlanButton.disabled = true;
  submitPayoutPlanButton.disabled = true;
  finalizePayoutPlanButton.disabled = true;
  if (publicDistributionButton) publicDistributionButton.disabled = true;
  for (const button of [publicDistributionPrepareButton, publicDistributionAuthorizeButton, publicDistributionStartButton, publicDistributionContinueButton, publicDistributionStatusButton]) if (button) button.disabled = true;
  if (publicDistributionResult) publicDistributionResult.classList.add('hidden');
  if (publicDistributionExecutionResult) publicDistributionExecutionResult.classList.add('hidden');
  if (publicDistributionExecutionStatus) publicDistributionExecutionStatus.classList.add('hidden');
  payoutPlanAuthorizeResult.classList.add('hidden');
  payoutPlanSubmitResult.classList.add('hidden');
  payoutPlanFinalizeResult.classList.add('hidden');
  payoutPlanStatusResult.classList.add('hidden');
  payoutPlanResult.classList.add('hidden');
  contributionEvidenceResult.classList.add('hidden');
  contributionStatusResult.classList.add('hidden');
  if (verifySessionButton) verifySessionButton.disabled = true;
}
function showSession(session) {
  document.querySelector('#wallet-name').textContent = session.walletName ?? 'Connected wallet';
  accountNode.textContent = session.accountId;
  accountCard.classList.remove('hidden');
  circleCreateSection.classList.remove('hidden');
  circlePolicySection.classList.remove('hidden');
  circleInvitationSection.classList.remove('hidden');
  quoteButton.disabled = false;
  contributionStatusButton.disabled = false;
  contributionEvidenceButton.disabled = false;
  nativeEvidenceStatusButton.disabled = false;
  nativeContributionButton.disabled = false;
  preparePayoutPlanButton.disabled = false;
  payoutPlanStatusButton.disabled = false;
  authorizePayoutPlanButton.disabled = false;
  submitPayoutPlanButton.disabled = false;
  finalizePayoutPlanButton.disabled = false;
  if (publicDistributionButton) publicDistributionButton.disabled = false;
  for (const button of [publicDistributionPrepareButton, publicDistributionAuthorizeButton, publicDistributionStartButton, publicDistributionContinueButton, publicDistributionStatusButton]) if (button) button.disabled = false;
  verifySessionButton.disabled = false;
  refreshQuoteAvailability();
}
async function checkNativeEvidenceStatus(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Sign in again before checking contribution history.', 'error');
    return;
  }
  const circleId = String(new FormData(nativeEvidenceStatusForm).get('circleId') ?? '').trim();
  const round = String(new FormData(nativeEvidenceStatusForm).get('round') ?? '').trim();
  if (!circleId || circleId.length > 200 || !/^(0|[1-9][0-9]{0,3})$/.test(round)) {
    setStatus('Enter a valid circle ID and round number.', 'error');
    return;
  }
  nativeEvidenceStatusButton.disabled = true;
  nativeEvidenceStatusResult.classList.remove('hidden');
  nativeEvidenceStatusResult.textContent = 'Checking stored evidence and current testnet state. Read-only; no transaction will be sent.';
  try {
    const verified = await api('/api/auth/near/session', { method: 'POST', headers: { authorization: `Bearer ${session.token}` } });
    if (verified.accountId !== session.accountId) throw new Error('The verified wallet differs from this session. Sign in again.');
    const query = new URLSearchParams({ circleId, round });
    const result = await api(`/api/member/native-contribution-status?${query}`, { headers: { authorization: `Bearer ${session.token}` } });
    nativeEvidenceStatusResult.textContent = JSON.stringify(result, null, 2);
    setStatus('Native contribution status check completed.', 'success');
  } catch (error) {
    nativeEvidenceStatusResult.textContent = JSON.stringify({ error: error.code ?? 'STATUS_CHECK_FAILED', message: error.message }, null, 2);
    if (error.status === 401) clearSession();
    setStatus(error.message || 'Could not check native contribution status.', 'error');
  } finally {
    nativeEvidenceStatusButton.disabled = false;
  }
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new Error('Cannot reach the AjoCircle API. Check that the real testnet server is running and the API URL is correct.');
  }
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.message ?? body.error ?? `API request failed (${response.status})`);
    error.status = response.status;
    error.code = body.error;
    error.creatorAccountId = body.creatorAccountId;
    throw error;
  }
  return body;
}
async function assessPublicDistribution(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Sign in before assessing public distribution.', 'error');
    return;
  }
  const circleId = String(new FormData(publicDistributionForm).get('circleId') ?? '').trim();
  if (!circleId || circleId.length > 200) {
    setStatus('Enter a valid circle ID.', 'error');
    return;
  }
  publicDistributionButton.disabled = true;
  publicDistributionResult.classList.remove('hidden');
  publicDistributionResult.textContent = 'Verifying this session and reading finalized NEAR testnet state. Read-only; no transaction will be sent.';
  try {
    const verified = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    });
    if (verified.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different wallet account. Sign in again.');
    }
    const result = await api('/api/agent/public-distribution-assessment', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId }),
    });
    const assessment = result.assessment;
    if (!assessment || result.transactionSubmitted !== false || assessment.transactionSubmitted !== false) {
      throw new Error('The API response did not prove that this was a read-only assessment. Treat the result as unverified.');
    }
    const status = assessment.status;
    const summaries = {
      READY_TO_START: 'All checked prerequisites pass. Distribution is ready to be reviewed, but this screen will not start it.',
      TRANSFER_PENDING: 'A transfer is already pending. Do not retry or submit another transaction; reconcile the existing transfer.',
      RETRY_AVAILABLE: 'The plan exists and the current transfer is not pending. This screen will not retry it; review on-chain state and authorized recovery procedures first.',
      COMPLETE: 'The public distribution is complete according to finalized contract state.',
    };
    publicDistributionResult.textContent = JSON.stringify({
      status,
      circleId: result.circleId,
      contractId: result.contractId,
      index: assessment.index,
      pending: assessment.pending,
      complete: assessment.complete,
      plan: assessment.plan,
      verifiedTotals: assessment.verifiedTotals,
      transactionSubmitted: false,
      message: summaries[status] ?? 'The assessment returned an unrecognized status. Do not take action based on it.',
      note: result.note,
    }, null, 2);
    setStatus(summaries[status] ?? 'Assessment returned an unrecognized status; no transaction was sent.',
      status === 'COMPLETE' ? 'success' : status === 'READY_TO_START' ? 'success' : 'info');
  } catch (error) {
    publicDistributionResult.textContent = JSON.stringify({
      status: 'BLOCKED_OR_UNAVAILABLE',
      error: error.code ?? 'PUBLIC_DISTRIBUTION_ASSESSMENT_FAILED',
      message: error.message,
      transactionSubmitted: false,
      instruction: 'No transaction was submitted by this assessment. Resolve the reported verification, membership, schedule, or RPC issue and rerun the read-only check.',
    }, null, 2);
    if (error.status === 401) clearSession();
    setStatus(error.message || 'Could not assess public distribution.', 'error');
  } finally {
    publicDistributionButton.disabled = !getSession();
  }
}

function formatYoctoNearText(value) {
  const amount = BigInt(value);
  const scale = 10n ** 24n;
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} NEAR` : `${whole} NEAR`;
}

async function runPublicDistributionAction(event, action, form, output) {
  event.preventDefault();
  const session = getSession();
  if (!session) { clearSession(); setStatus('Sign in before managing public distribution.', 'error'); return; }
  const data = new FormData(form);
  const body = { action };
  if (action === 'prepare') body.circleId = String(data.get('circleId') ?? '').trim();
  else body.planId = String(data.get('planId') ?? '').trim();
  if (['authorize', 'start', 'continue'].includes(action)) body.confirmation = String(data.get('confirmation') ?? '').trim();
  if ((action === 'prepare' && !body.circleId) || (action !== 'prepare' && !body.planId)) { setStatus('Enter the required circle or plan ID.', 'error'); return; }
  if (action === 'start' || action === 'continue') {
    const plan = currentPublicDistributionPlan;
    if (!plan || plan.id !== body.planId || !Array.isArray(plan.distributionPlan) || !Array.isArray(plan.txHashes)) {
      setStatus('Check the current distribution plan status first so the exact recipient and amount can be verified.', 'error');
      return;
    }
    const nextIndex = plan.txHashes.length;
    const next = plan.distributionPlan[nextIndex];
    if (!next) { setStatus('No next recipient remains. Check status to verify completion.', 'info'); return; }
    const newline = String.fromCharCode(10);
    const distributionLines = plan.distributionPlan.map(item => `  ${item.member}: ${formatYoctoNearText(item.amountYocto)}`).join(newline);
    const confirmation = ['NEAR TESTNET DISTRIBUTION CONFIRMATION', '', `Contract: ${plan.contractId}`, `Network: ${plan.network}`, `Round: ${plan.round} (final round)`, `Approved code SHA-256: ${plan.codeSha256}`, `Treasury signer: ${plan.contractId} (existing local NEAR CLI FullAccess key)`, '', `NEXT TRANSFER ${nextIndex + 1} OF ${plan.distributionPlan.length}:`, `Recipient: ${next.member}`, `Amount: ${formatYoctoNearText(next.amountYocto)}`, '', 'FULL DISTRIBUTION PLAN:', distributionLines, '', `Total: ${formatYoctoNearText(plan.totalYocto)}`, '', 'Only this one transfer call will be submitted. Continue only after checking the on-chain status. Proceed?'].join(newline);
    if (!window.confirm(confirmation)) { setStatus('Distribution transaction was not submitted; confirmation was cancelled.', 'info'); return; }
  }
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  output.classList.remove('hidden');
  output.textContent = action === 'status' ? 'Reading finalized distribution state; no transaction will be sent.' : 'Checking authenticated membership, exact plan state, and finalized testnet contract before proceeding...';
  try {
    const verified = await api('/api/auth/near/session', { method: 'POST', headers: { authorization: `Bearer ${session.token}` } });
    if (verified.accountId !== session.accountId) { clearSession(); throw new Error('The verified wallet differs from this session. Sign in again.'); }
    const result = await api('/api/agent/public-distribution-execution', { method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) });
    output.textContent = JSON.stringify(result, null, 2);
    const plan = result.plan;
    if (plan?.id) currentPublicDistributionPlan = plan;
    if (plan?.id) {
      for (const target of [publicDistributionAuthorizeForm, publicDistributionStartForm, publicDistributionContinueForm, publicDistributionStatusForm]) target.elements.planId.value = plan.id;
      const phrase = `START TESTNET DISTRIBUTION ${plan.contractId} ROUND ${plan.round} TOTAL ${plan.totalYocto} YOCTO`;
      publicDistributionStartForm.elements.confirmation.value = phrase;
      publicDistributionContinueForm.elements.confirmation.value = phrase;
      if (action === 'prepare' && result.authorizationPhrase) publicDistributionAuthorizeForm.elements.confirmation.value = result.authorizationPhrase;
    }
    if (result.transactionSubmitted === 'UNKNOWN' || result.plan?.state === 'UNKNOWN') {
      setStatus('Distribution submission outcome is uncertain. Do not retry; reconcile on-chain state first.', 'error');
    } else if (result.error) {
      setStatus(result.message ?? result.error, 'error');
    } else if (action === 'start' || action === 'continue') {
      setStatus('One distribution transaction was submitted and its finalized testnet transaction evidence was checked. Check status before continuing.', 'success');
    } else if (action === 'authorize') {
      setStatus('Second-member authorization recorded. No funds moved.', 'success');
    } else if (action === 'status' && result.plan?.state === 'FINALIZED') {
      setStatus('All three distribution transfers are finalized and independently verified.', 'success');
    } else {
      setStatus(action === 'prepare' ? 'Distribution plan prepared. No funds moved; a different member must authorize it.' : 'Distribution status refreshed.', 'info');
    }
  } catch (error) {
    output.textContent = JSON.stringify({ error: error.code ?? 'PUBLIC_DISTRIBUTION_ACTION_FAILED', message: error.message, transactionSubmitted: false }, null, 2);
    if (error.status === 401) clearSession();
    setStatus(error.message || 'Public distribution action failed.', 'error');
  } finally {
    if (button) button.disabled = !getSession();
  }
}

function decodeBase64Nonce(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('The server returned an invalid challenge nonce.');
  return bytes;
}
function normalizeSignatureEvent(event) {
  const account = event?.accounts?.[0] ?? event?.account ?? {};
  const signed = account.signedMessage ?? event?.signedMessage ?? event?.signatureResult ?? {};
  const accountId = signed.accountId ?? signed.account_id ?? account.accountId ?? account.account_id;
  const publicKey = signed.publicKey ?? signed.public_key ?? account.publicKey ?? account.public_key;
  let signature = signed.signature ?? account.signature;
  if (signature instanceof Uint8Array) signature = btoa(String.fromCharCode(...signature));
  if (typeof signature === 'string' && signature.startsWith('ed25519:')) signature = signature.slice('ed25519:'.length);
  return { accountId, publicKey, signature };
}
function isUserRejection(error) {
  const message = `${error?.message ?? ''} ${error?.code ?? ''}`;
  return /reject|denied|cancel(?:led|ed)|user.?abort|4001/i.test(message);
}
function failSigning(message, kind = 'error') {
  clearTimeout(signatureTimeout);
  sessionStorage.removeItem(CHALLENGE_KEY);
  signingFlowActive = false;
  handlingSignature = false;
  connectButton.disabled = false;
  setStatus(message, kind);
}

async function onSignedMessage(event) {
  if (handlingSignature) return;
  const serialized = sessionStorage.getItem(CHALLENGE_KEY);
  if (!serialized) return;
  handlingSignature = true;
  clearTimeout(signatureTimeout);
  try {
    const challenge = JSON.parse(serialized);
    if (!challenge?.expiresAt || Date.parse(challenge.expiresAt) <= Date.now()) {
      failSigning('This sign-in challenge has expired. Start again to request a fresh challenge.');
      return;
    }
    const walletName = event?.wallet?.manifest?.name ?? 'Connected wallet';
    const signed = normalizeSignatureEvent(event);
    if (typeof signed.accountId !== 'string' || typeof signed.publicKey !== 'string' || typeof signed.signature !== 'string' || !signed.signature) {
      failSigning('This wallet did not return a usable NEP-413 signature. Choose a wallet that supports signMessage on testnet.');
      return;
    }
    setStatus('Verifying your signature with the AjoCircle server…');
    let result;
    try {
      result = await api('/api/auth/near/verify', {
        method: 'POST',
        body: JSON.stringify({
          nonce: challenge.nonce,
          accountId: signed.accountId,
          publicKey: signed.publicKey,
          signature: signed.signature,
          message: challenge.message,
          recipient: challenge.recipient,
        }),
      });
    } catch (error) {
      if (Date.parse(challenge.expiresAt) <= Date.now()) {
        failSigning('This sign-in challenge expired before verification finished. Start again.');
      } else if (error.status === 401 || error.code === 'WALLET_AUTH_REJECTED') {
        failSigning('The wallet signature was rejected or could not be verified. Check the wallet details and try again with a fresh challenge.');
      } else {
        failSigning(error.message || 'Sign-in verification failed.');
      }
      return;
    }
    if (typeof result.token !== 'string' || !result.token || typeof result.accountId !== 'string' || typeof result.expiresAt !== 'string') {
      failSigning('The server returned an incomplete session. No session was saved.');
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, result.token);
    sessionStorage.setItem(ACCOUNT_KEY, result.accountId);
    sessionStorage.setItem(WALLET_KEY, walletName);
    sessionStorage.setItem(EXPIRY_KEY, result.expiresAt);
    sessionStorage.removeItem(CHALLENGE_KEY);
    signingFlowActive = false;
    handlingSignature = false;
    connectButton.disabled = false;
    showSession({ accountId: result.accountId, walletName, expiresAt: result.expiresAt });
    setStatus(`Signed in. Session expires ${new Date(result.expiresAt).toLocaleTimeString()}.`, 'success');
    if (pendingInviteLoaded) {
      pendingInviteLoaded = false;
      void previewCirclePolicy();
    }
  } catch {
    failSigning('Could not process the wallet response. Start again with a fresh challenge.');
  }
}

async function startLogin() {
  if (signingFlowActive) return;
  signingFlowActive = true;
  handlingSignature = false;
  connectButton.disabled = true;
  setStatus('Requesting a single-use challenge from the server…');
  try {
    const response = await api('/api/auth/near/challenge', { method: 'POST', body: '{}' });
    const challenge = response.challenge;
    if (!challenge || typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string' || typeof challenge.recipient !== 'string' || typeof challenge.expiresAt !== 'string') {
      throw new Error('The server returned an invalid challenge response.');
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('The server returned an expired challenge. Try again.');
    const nonce = decodeBase64Nonce(challenge.nonce);
    sessionStorage.setItem(CHALLENGE_KEY, JSON.stringify(challenge));
    setStatus('Choose a compatible testnet wallet and approve the message signature. No transaction will be sent.');
    signatureTimeout = setTimeout(() => {
      if (sessionStorage.getItem(CHALLENGE_KEY)) failSigning('No signature was returned. The wallet may not support NEP-413 signMessage, or the request was cancelled. Try a supported testnet wallet.');
    }, 120_000);
    await connector.connect({ signMessageParams: { message: challenge.message, recipient: challenge.recipient, nonce } });
  } catch (error) {
    if (sessionStorage.getItem(CHALLENGE_KEY)) {
      if (isUserRejection(error)) failSigning('You rejected or cancelled the signature request. Nothing was sent. You can try again.');
      else failSigning(error.message || 'Could not open a compatible wallet. Try a NEP-413-capable testnet wallet.');
    } else {
      signingFlowActive = false;
      connectButton.disabled = false;
      if (isUserRejection(error)) setStatus('You cancelled wallet sign-in. No transaction was sent.', 'error');
      else setStatus(error.message || 'Could not start sign-in.', 'error');
    }
  }
}

async function verifyCurrentSession() {
  const session = getSession();
  if (!session) {
    setStatus('Your session has expired. Sign in again before verifying it.', 'error');
    return;
  }
  verifySessionButton.disabled = true;
  sessionResult.classList.remove('hidden');
  sessionResult.textContent = 'Checking the bearer session with the server?';
  try {
    const verified = await api('/api/auth/near/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (verified.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different account. Please sign in again.');
    }
    sessionResult.textContent = JSON.stringify({ status: 'verified', accountId: verified.accountId, expiresAt: verified.expiresAt }, null, 2);
    setStatus('Session token verified by the server.', 'success');
  } catch (error) {
    sessionResult.textContent = JSON.stringify({ status: 'failed', error: error.code ?? 'SESSION_CHECK_FAILED', message: error.message }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('The server rejected or expired this session. Sign in again.', 'error');
    } else {
      setStatus(error.message || 'Session verification failed.', 'error');
    }
  } finally {
    verifySessionButton.disabled = !getSession();
  }
}

async function checkContributionStatus(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Your session has expired. Sign in again before checking contribution status.', 'error');
    return;
  }
  const intentId = String(new FormData(contributionStatusForm).get('intentId') ?? '').trim();
  if (!intentId || intentId.length > 200) {
    setStatus('Enter a valid settlement intent ID.', 'error');
    return;
  }
  contributionStatusButton.disabled = true;
  contributionStatusResult.classList.remove('hidden');
  contributionStatusResult.textContent = 'Verifying your session and checking current read-only contract state…';
  try {
    const verified = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    });
    if (verified.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different account. Sign in again.');
    }
    const result = await api(`/api/member/contribution-status?intentId=${encodeURIComponent(intentId)}`, {
      method: 'GET', headers: { authorization: `Bearer ${session.token}` },
    });
    const status = result.status;
    applyVerifiedCircleLifecycle(status.circleId, {
      verified: true,
      circleCompleted: status.circleCompleted,
      payoutPending: status.payoutPending,
      payoutComplete: status.payoutComplete,
      verifiedAt: new Date().toISOString(),
    });
    const contractLabels = {
      CONTRIBUTION_CONFIRMED: 'Confirmed on-chain',
      NO_CONTRIBUTION: 'No contribution recorded on-chain',
      ROUND_MISMATCH: 'This intent belongs to a different round',
      AMOUNT_MISMATCH: 'On-chain amount does not match the required amount',
      CIRCLE_COMPLETED: 'Circle already completed',
    };
    const swapLabels = {
      SWAP_DELIVERED: 'Swap delivery verified',
      AWAITING_SWAP_DELIVERY: 'Swap delivery not yet verified',
    };
    const actionLabels = {
      PAYOUT_PENDING: 'Wait for the payout process to finish',
      PAYOUT_COMPLETE: 'Payout is complete',
      CONTRIBUTION_CONFIRMED: 'No further contribution action is indicated for this intent',
      CHECK_CURRENT_ROUND: 'Check the current round before taking any action',
      MANUAL_REVIEW_REQUIRED: 'Stop and request a manual review; do not retry a payment',
      CIRCLE_COMPLETED: 'No further contribution is required for this completed circle',
      UNWRAP_AND_SUBMIT_NATIVE_NEAR_CONTRIBUTION: 'If you choose to proceed, unwrap the delivered wrapped NEAR and submit the exact native-NEAR contribution separately',
      WAIT_FOR_SWAP_SETTLEMENT: 'Wait for verified swap delivery; do not treat this as a contribution',
    };
    contributionStatusResult.textContent = [
      `Circle: ${status.circleId}`,
      `Member: ${status.memberNearAccount}`,
      `Intent round: ${status.intentRound} | Current on-chain round: ${status.contractRound}`,
      `Swap: ${swapLabels[status.swapStatus] ?? status.swapStatus}`,
      `Contribution: ${contractLabels[status.contractStatus] ?? status.contractStatus}`,
      `Required native NEAR (yoctoNEAR): ${status.requiredContributionAmount}`,
      status.contributionAmount ? `Recorded native NEAR (yoctoNEAR): ${status.contributionAmount}` : 'Recorded native NEAR: none confirmed',
      `Payout pending: ${status.payoutPending}`,
      `Payout complete: ${status.payoutComplete}`,
      `Circle complete: ${status.circleCompleted}`,
      `Next step: ${actionLabels[status.nextAction] ?? status.nextAction}`,
      '',
      'Read-only check only. No transaction was submitted.',
    ].join('\n');
    setStatus('Contribution status refreshed from read-only contract views. No transaction was submitted.', 'success');
  } catch (error) {
    contributionStatusResult.textContent = JSON.stringify({ error: error.code ?? 'STATUS_CHECK_FAILED', message: error.message }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('The server rejected or expired this session. Sign in again.', 'error');
    } else {
      setStatus(error.message || 'Could not check contribution status.', 'error');
    }
  } finally {
    contributionStatusButton.disabled = !getSession();
  }
}

async function submitContributionEvidence(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Your session has expired. Sign in again before submitting contribution evidence.', 'error');
    return;
  }
  const form = new FormData(contributionEvidenceForm);
  const circleId = String(form.get('circleId') ?? '').trim();
  const roundText = String(form.get('round') ?? '').trim();
  const transactionHash = String(form.get('transactionHash') ?? '').trim();
  const round = Number(roundText);
  if (!circleId || circleId.length > 200 || !/^(0|[1-9][0-9]*)$/.test(roundText)
      || !Number.isSafeInteger(round) || round > 1000
      || !transactionHash || transactionHash.length > 128
      || !/^[A-Za-z0-9_-]+$/.test(transactionHash)) {
    setStatus('Enter a circle ID, a whole-number round, and a valid-looking NEAR transaction hash.', 'error');
    return;
  }
  contributionEvidenceButton.disabled = true;
  contributionEvidenceResult.classList.remove('hidden');
  contributionEvidenceResult.textContent = 'Verifying your session, finalized NEAR transaction, contract, contribution amount, deadline, and trusted membership…';
  try {
    const verified = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    });
    if (verified.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different account. Sign in again.');
    }
    const result = await api('/api/member/contribution-evidence', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId, round, transactionHash }),
    });
    contributionEvidenceResult.textContent = JSON.stringify(result, null, 2);
    setStatus('Contribution evidence verified and recorded. Reputation was updated by the trusted server.', 'success');
  } catch (error) {
    const messages = {
      EVIDENCE_ALREADY_RECORDED: 'This transaction has already been recorded for reputation. No second score was added.',
      CONTRIBUTION_NOT_ELIGIBLE: 'The signed-in wallet is not an active member of this circle, or trusted circle context is unavailable.',
      CONTRIBUTION_EVIDENCE_REJECTED: 'The transaction failed verification. Confirm the testnet hash, signer, contract, amount, round, and deadline.',
      INVALID_BODY: 'Check the circle ID, round, and transaction hash fields.',
      UNAUTHENTICATED: 'Your session is not valid. Sign in again.',
      INGESTION_UNAVAILABLE: 'The server could not finish recording evidence. You may retry the same transaction hash safely.',
    };
    contributionEvidenceResult.textContent = JSON.stringify({
      status: 'failed',
      error: error.code ?? 'CONTRIBUTION_EVIDENCE_FAILED',
      message: messages[error.code] ?? error.message,
    }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('The server rejected or expired this session. Sign in again.', 'error');
    } else {
      setStatus(messages[error.code] ?? error.message ?? 'Contribution evidence was not recorded.', 'error');
    }
  } finally {
    contributionEvidenceButton.disabled = !getSession();
  }
}

async function readNearRpc(method, params) {
  const response = await fetch('https://rpc.testnet.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ajocircle-wallet-contribution', method, params }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`NEAR testnet RPC returned HTTP ${response.status}.`);
  // Keep u64 nanosecond block timestamps exact when parsing JSON.
  const payload = JSON.parse(raw.replace(/("timestamp_nanosec"\s*:\s*)([0-9]+)/g, '$1"$2"'));
  if (payload?.error || !Object.hasOwn(payload ?? {}, 'result')) throw new Error('NEAR testnet RPC did not return a valid result.');
  return payload.result;
}

async function readNearContractView(contractId, methodName, args = {}) {
  const result = await readNearRpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: btoa(unescape(encodeURIComponent(JSON.stringify(args)))),
  });
  if (!Array.isArray(result?.result) || result.result.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`The contract returned an invalid ${methodName} view result.`);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.result)));
}

async function submitNativeContribution(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Sign in with your NEAR testnet wallet before contributing.', 'error');
    return;
  }
  const circleId = String(new FormData(nativeContributionForm).get('circleId') ?? '').trim();
  if (!circleId || circleId.length > 200) {
    setStatus('Enter the circle ID created in AjoCircle.', 'error');
    return;
  }

  nativeContributionButton.disabled = true;
  nativeContributionResult.classList.remove('hidden');
  nativeContributionResult.textContent = 'Checking your session, approved contract, saved schedule parity, and live testnet round. No transaction has been sent…';
  let walletSubmissionAttempted = false;
  try {
    const verifiedSession = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    });
    if (verifiedSession.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different wallet account. Sign in again.');
    }

    const result = await api('/api/circle/verify-contract', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId }),
    });
    const binding = result.binding;
    if (result.quoteReady !== true || binding?.quoteReady !== true || binding?.network !== 'testnet'
        || !binding.contractId || !binding.verification
        || !Array.isArray(binding.verification.members)) {
      throw new Error(binding?.quoteReadinessReason
        || 'Exact persisted local/on-chain schedule parity is not ready. No transaction was sent.');
    }
    const verifiedAt = Date.parse(binding.verifiedAt ?? '');
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt < 0 || Date.now() - verifiedAt > 60_000) {
      throw new Error('The server verification is stale. Retry to obtain fresh contract evidence.');
    }

    const { wallet, accounts } = await connector.getConnectedWallet();
    if (!wallet || !Array.isArray(accounts) || !accounts.some(account => account.accountId === session.accountId)) {
      throw new Error('Reconnect the same NEAR testnet wallet used to sign in. No transaction was sent.');
    }
    const contractId = binding.contractId;
    const accountId = session.accountId;
    if (!binding.verification.members.includes(accountId)) {
      throw new Error(`Signed-in wallet "${accountId}" is not a member of the verified on-chain circle. Eligible on-chain members: ${binding.verification.members.join(', ')}. Sign out and sign in with one of those wallets; no transaction was sent.`);
    }

    const [round, amountRaw, deadlineRaw, memberList, existingContribution, completed, payoutPending, payoutComplete, block] = await Promise.all([
      readNearContractView(contractId, 'get_round'),
      readNearContractView(contractId, 'get_contribution_amount'),
      readNearContractView(contractId, 'get_round_deadline'),
      readNearContractView(contractId, 'get_members'),
      readNearContractView(contractId, 'get_contribution', { member: accountId }),
      readNearContractView(contractId, 'is_circle_completed'),
      readNearContractView(contractId, 'is_payout_pending'),
      readNearContractView(contractId, 'is_payout_complete'),
      readNearRpc('block', { finality: 'final' }),
    ]);
    const amount = String(amountRaw);
    const deadlineNs = String(deadlineRaw);
    if (!Number.isSafeInteger(round) || round < 0 || !/^[1-9][0-9]*$/.test(amount)
        || !/^[0-9]+$/.test(deadlineNs) || !Array.isArray(memberList)
        || memberList.length !== binding.verification.members.length
        || memberList.some((member, index) => member !== binding.verification.members[index])
        || String(binding.verification.currentRound) !== String(round)
        || String(binding.verification.contributionAmount) !== amount
        || String(binding.verification.roundDeadline) !== deadlineNs) {
      throw new Error('The live contract round or contribution schedule changed since verification. Verify the circle again; no transaction was sent.');
    }
    if (completed === true || payoutPending === true || payoutComplete === true) {
      throw new Error('The circle is completed or settling. Contributions are blocked.');
    }
    if (memberList.includes(accountId) !== true) throw new Error('The connected wallet is not an on-chain circle member.');
    if (existingContribution !== null && existingContribution !== undefined && String(existingContribution) !== '0') {
      throw new Error('This wallet already has a recorded contribution for the current round.');
    }
    const blockTimestampNs = block?.header?.timestamp_nanosec;
    if (!/^[0-9]+$/.test(String(blockTimestampNs ?? '')) || BigInt(deadlineNs) <= BigInt(blockTimestampNs)) {
      throw new Error('The current round deadline has passed or cannot be verified. No transaction was sent.');
    }

    const nativeAmountNear = (Number(BigInt(amount) / 10n ** 24n)
      + Number(BigInt(amount) % (10n ** 24n)) / 1e24).toLocaleString('en-US', { maximumFractionDigits: 6 });
    const confirmed = window.confirm(
      `AjoCircle testnet contribution review\n\nCircle: ${circleId}\nContract: ${contractId}\nWallet: ${accountId}\nRound: ${round}\nExact native NEAR deposit: ${amount} yoctoNEAR (${nativeAmountNear} NEAR)\n\nYour wallet will ask you to approve the transaction. Continue to wallet approval?`
    );
    if (!confirmed) {
      nativeContributionResult.textContent = JSON.stringify({ status: 'CANCELLED', circleId, contractId, round, transactionSent: false }, null, 2);
      setStatus('Contribution cancelled before wallet approval. No transaction was sent.');
      return;
    }

    nativeContributionResult.textContent = 'Opening your connected testnet wallet for explicit approval. Review the contract, method, and exact deposit in the wallet…';
    walletSubmissionAttempted = true;
    const outcome = await wallet.signAndSendTransaction({
      network: 'testnet',
      signerId: accountId,
      receiverId: contractId,
      actions: [{
        type: 'FunctionCall',
        params: {
          methodName: 'contribute',
          args: {},
          gas: '30000000000000',
          deposit: amount,
        },
      }],
    });
    const transactionHash = outcome?.transaction?.hash;
    const receiptFailed = Array.isArray(outcome?.receipts_outcome)
      && outcome.receipts_outcome.some(receipt => receipt?.outcome?.status?.Failure);
    if (!transactionHash || outcome?.status?.Failure || receiptFailed
        || !(outcome?.status && (Object.hasOwn(outcome.status, 'SuccessValue') || Object.hasOwn(outcome.status, 'SuccessReceiptId')))) {
      nativeContributionResult.textContent = JSON.stringify({
        status: 'TRANSACTION_NOT_CONFIRMED',
        circleId, contractId, round,
        transactionHash: transactionHash ?? null,
        message: 'The wallet did not return a confirmed successful transaction outcome. Do not record this as a contribution.',
      }, null, 2);
      setStatus('No successful contribution was confirmed by the wallet. Check the transaction before retrying.', 'error');
      return;
    }

    contributionEvidenceForm.elements.circleId.value = circleId;
    contributionEvidenceForm.elements.round.value = String(round);
    contributionEvidenceForm.elements.transactionHash.value = transactionHash;
    nativeContributionResult.textContent = JSON.stringify({
      status: 'TRANSACTION_FINALIZED',
      network: 'testnet',
      circleId, contractId, signerId: accountId, round,
      amountYocto: amount,
      transactionHash,
      evidence: 'Submitting the finalized transaction to the server for independent verification before it can affect reputation.',
    }, null, 2);
    try {
      const evidence = await api('/api/member/contribution-evidence', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ circleId, round, transactionHash }),
      });
      nativeContributionResult.textContent = JSON.stringify({
        status: 'CONTRIBUTION_FINALIZED_AND_EVIDENCE_VERIFIED',
        network: 'testnet', circleId, contractId, signerId: accountId, round,
        amountYocto: amount, transactionHash, evidence,
      }, null, 2);
      setStatus('The native NEAR contribution finalized and the server verified its evidence.', 'success');
    } catch (evidenceError) {
      nativeContributionResult.textContent = JSON.stringify({
        status: 'TRANSACTION_FINALIZED_EVIDENCE_PENDING',
        network: 'testnet', circleId, contractId, signerId: accountId, round,
        amountYocto: amount, transactionHash,
        evidenceError: evidenceError.code ?? 'EVIDENCE_VERIFICATION_FAILED',
        message: evidenceError.message,
        nextStep: 'The transaction was finalized, but the server has not confirmed contribution evidence. The real transaction hash has been placed in the evidence form for a separate retry. Do not submit another contribution.',
      }, null, 2);
      setStatus('The transaction finalized, but evidence verification needs follow-up. Do not contribute again.', 'info');
    }
  } catch (error) {
    nativeContributionResult.textContent = JSON.stringify({
      status: 'BLOCKED_OR_FAILED',
      error: error.code ?? 'NATIVE_CONTRIBUTION_FAILED',
      message: error.message,
      transactionSent: walletSubmissionAttempted ? 'UNKNOWN' : false,
    }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('Your session expired. Sign in again before retrying.', 'error');
    } else {
      setStatus(walletSubmissionAttempted ? 'Wallet submission did not return a confirmed result. Check the wallet or explorer before retrying.' : (error.message || 'Contribution preflight failed. No transaction was sent.'), 'error');
    }
  } finally {
    nativeContributionButton.disabled = !getSession();
  }
}

async function loadApprovedOriginAssets() {
  const session = getSession();
  originAssetSelect.replaceChildren(new Option('Loading server-approved assets?', ''));
  originAssetSelect.disabled = true;
  if (!session) { originAssetSelect.replaceChildren(new Option('Sign in to load approved assets', '')); return; }
  try {
    const result = await api('/api/circle/assets/available', { headers: { authorization: `Bearer ${session.token}` } });
    originAssetSelect.replaceChildren();
    if (!Array.isArray(result.assets) || result.assets.length === 0) {
      originAssetSelect.add(new Option('No server-approved assets configured', ''));
      quoteResult.classList.remove('hidden');
      quoteResult.textContent = JSON.stringify({ status: 'ORIGIN_ASSET_ALLOWLIST_EMPTY', message: 'No server-approved origin assets are configured. Quote preview remains unavailable; no asset ID will be guessed.' }, null, 2);
      return;
    }
    originAssetSelect.add(new Option('Choose an approved asset?', ''));
    for (const asset of result.assets) {
      if (typeof asset?.id === 'string' && asset.id.trim()) originAssetSelect.add(new Option(asset.label || asset.id, asset.id));
    }
    originAssetSelect.disabled = false;
  } catch (error) {
    originAssetSelect.replaceChildren(new Option('Could not load approved assets', ''));
    if (error.status === 401) clearSession();
  }
}

async function requestQuote(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Your session has expired. Sign in again before requesting a quote.', 'error');
    return;
  }
  const data = new FormData(quoteForm);
  const payload = {
    circleId: String(data.get('circleId') ?? '').trim(),
    round: Number(data.get('round')),
    originAsset: String(data.get('originAsset') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
  };
  const lifecycle = verifiedCircleLifecycle.get(payload.circleId);
  const verifiedAtMs = Date.parse(lifecycle?.verifiedAt ?? '');
  const lifecycleAgeMs = Date.now() - verifiedAtMs;
  const lifecycleFresh = Boolean(lifecycle) && Number.isFinite(verifiedAtMs)
    && lifecycleAgeMs >= 0 && lifecycleAgeMs <= 60_000;
  const terminalLifecycle = lifecycle?.circleCompleted === true
    || lifecycle?.payoutPending === true || lifecycle?.payoutComplete === true;
  if (!lifecycleFresh || terminalLifecycle) {
    refreshQuoteAvailability();
    const message = lifecycle?.circleCompleted === true
      ? 'This circle is completed on-chain. No further quote preview is allowed.'
      : lifecycle?.payoutPending === true || lifecycle?.payoutComplete === true
        ? 'This circle is settling or already paid. Refresh contract lifecycle before requesting another quote.'
        : 'Fresh contract lifecycle verification is required before requesting a quote preview.';
    quoteResult.classList.remove('hidden');
    quoteResult.textContent = JSON.stringify({
      status: lifecycle?.circleCompleted === true ? 'CIRCLE_COMPLETED'
        : lifecycle?.payoutPending === true ? 'PAYOUT_PENDING'
          : lifecycle?.payoutComplete === true ? 'PAYOUT_COMPLETE' : 'FRESH_VERIFICATION_REQUIRED',
      circleId: payload.circleId,
      message,
    }, null, 2);
    setStatus(message, 'error');
    return;
  }
  quoteButton.disabled = true;
  quoteResult.classList.remove('hidden');
  quoteResult.textContent = 'Requesting an estimate-only preview. No deposit instructions will be created…';
  let verifiedSession = null;
  try {
    verifiedSession = await api('/api/auth/near/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (verifiedSession.accountId !== session.accountId) {
      clearSession();
      const mismatch = new Error('The server verified a different account. Sign in again.');
      mismatch.status = 401;
      throw mismatch;
    }
    const result = await api('/api/member/quote/preview', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify(payload),
    });
    quoteResult.textContent = JSON.stringify(result, null, 2);
    setStatus('Estimate-only preview received. No settlement intent or deposit instructions were created; this is not a contribution.', 'success');
  } catch (error) {
    if (error.code === 'TESTNET_QUOTE_BACKEND_NOT_CONFIGURED' && verifiedSession?.accountId === session.accountId) {
      quoteResult.textContent = JSON.stringify({
        session: { status: 'verified', accountId: verifiedSession.accountId, expiresAt: verifiedSession.expiresAt },
        quote: { status: 'not_configured', message: 'The local test server has no membership/quote backend configured. No quote or transaction was created.' },
      }, null, 2);
      setStatus('Session token verified by the server. The quote backend is not configured yet.', 'success');
    } else {
      quoteResult.textContent = JSON.stringify({
        error: error.code ?? 'REQUEST_FAILED',
        message: error.message,
        nextSteps: [
          'The response did not confirm a quote; do not treat this as a successful quote.',
          'Check the circle ID, round number, active membership, and whether the round is still open.',
          'If contract verification or schedule parity is not ready, ask the circle creator to use Verify Contract and resolve any reported mismatch.',
          'A quote request does not itself send a contribution or payout transaction.',
        ],
      }, null, 2);
      if (error.status === 401) {
        clearSession();
        setStatus('The server rejected or expired this session. Sign in again.', 'error');
      } else {
        setStatus(error.message || 'Quote request failed.', 'error');
      }
    }
  } finally {
    refreshQuoteAvailability();
  }
}

async function createCircle(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before creating a circle setup.', 'error');
    return;
  }
  const data = new FormData(circleCreateForm);
  const payload = {
    contractId: String(data.get('contractId') ?? '').trim(),
    mode: String(data.get('mode') ?? ''),
    gracePeriodDays: Number(data.get('gracePeriodDays')),
  };
  createCircleButton.disabled = true;
  circleCreateResult.classList.remove('hidden');
  circleCreateResult.textContent = 'Creating local circle metadata and policy…';
  try {
    const result = await api('/api/circle/create', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify(payload),
    });
    const circle = result.circle;
    circleCreateResult.textContent = JSON.stringify({
      circleId: circle.circleId,
      contractId: circle.contractId,
      mode: circle.policy.mode,
      policyVersion: circle.policy.policyVersion,
      policyHash: circle.policy.policyHash,
      contractBindingVerified: circle.contractBindingVerified,
      policyAcceptanceRequired: circle.policyAcceptanceRequired,
      note: 'Local metadata only. No contract deployment, blockchain transaction, contribution, or payout occurred.',
    }, null, 2);
    policyPreviewForm.elements.circleId.value = circle.circleId;
    policyPreviewForm.elements.inviteToken.value = '';
    contractVerifyForm.elements.circleId.value = circle.circleId;
    importCycleCircleId.value = circle.circleId;
    contractVerificationResult.classList.add('hidden');
    cycleConfigureForm.elements.circleId.value = circle.circleId;
    invitationForm.elements.circleId.value = circle.circleId;
    quoteForm.elements.circleId.value = circle.circleId;
    setStatus('Circle metadata created. Preview the rules and explicitly accept them before starting the cycle.', 'success');
    await previewCirclePolicy();
  } catch (error) {
    circleCreateResult.textContent = JSON.stringify({ error: error.code ?? 'CIRCLE_CREATE_FAILED', message: error.message }, null, 2);
    setStatus(error.message || 'Could not create this circle setup.', 'error');
  } finally {
    createCircleButton.disabled = !getSession();
  }
}

async function verifyCircleContract(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before verifying a contract.', 'error');
    return;
  }
  const circleId = String(new FormData(contractVerifyForm).get('circleId') ?? '').trim();
  if (!circleId) {
    setStatus('Enter the circle ID to verify.', 'error');
    return;
  }
  verifyContractButton.disabled = true;
  contractVerificationResult.classList.remove('hidden');
  contractVerificationResult.textContent = 'Querying finalized NEAR testnet code and read-only contract views…';
  try {
    const result = await api('/api/circle/verify-contract', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId }),
    });
    const binding = result.binding;
    quoteForm.elements.circleId.value = circleId;
    nativeContributionForm.elements.circleId.value = circleId;
    applyVerifiedCircleLifecycle(circleId, {
      verified: true,
      circleCompleted: binding.circleCompleted,
      payoutPending: binding.payoutPending,
      payoutComplete: binding.payoutComplete,
      verifiedAt: binding.verifiedAt,
    });
    // Prefill parity forms from server-verified on-chain evidence; this only edits browser form fields.
    const onChain = binding.verification;
    if (onChain && Array.isArray(onChain.members) && Array.isArray(onChain.payoutOrder)
        && Array.isArray(onChain.rounds) && onChain.rounds.length >= 2) {
      scheduleParityForm.elements.circleId.value = circleId;
      scheduleParityForm.elements.members.value = onChain.members.join(', ');
      scheduleParityForm.elements.payoutOrder.value = onChain.payoutOrder.join(', ');
      scheduleParityForm.elements.treasurerAgent.value = onChain.treasurerAgent ?? '';
      cycleConfigureForm.elements.circleId.value = circleId;
      cycleConfigureForm.elements.contributionAmount.value = onChain.contributionAmount ?? onChain.rounds[0]?.contributionAmount ?? '';
      cycleConfigureForm.elements.memberCount.value = String(onChain.rounds.length);
      cycleConfigureForm.elements.exactDeadlinesNs.value = onChain.rounds.map(round => round.deadlineNs).join(', ');
      contractVerificationResult.dataset.schedulePrefilled = 'true';
    }
    contractVerificationResult.textContent = JSON.stringify({
      verified: true,
      network: binding.network,
      contractId: binding.contractId,
      codeSha256: binding.codeSha256,
      mode: binding.mode,
      currentRound: binding.currentRound,
      contributionCount: binding.contributionCount,
      currentRecipient: binding.currentRecipient,
      circleCompleted: binding.circleCompleted,
      payoutPending: binding.payoutPending,
      payoutComplete: binding.payoutComplete,
      quoteReady: result.quoteReady,
      quoteReadinessReason: binding.quoteReadinessReason,
      parityMismatches: binding.parityMismatches,
      localAndOnChainRounds: binding.verification?.rounds,
      verifiedAt: binding.verifiedAt,
      note: result.note,
    }, null, 2);
    setStatus(result.quoteReady ? 'Contract verification and exact local/on-chain schedule parity passed. Quote path is eligible for its remaining safeguards.' : 'Contract code and read-only state checks passed, but schedule parity is incomplete or mismatched; quotes remain blocked.', result.quoteReady ? 'success' : 'info');
  } catch (error) {
    contractVerificationResult.textContent = JSON.stringify({
      verified: false, error: error.code ?? 'CONTRACT_VERIFICATION_FAILED', message: error.message,
      note: 'No transaction was sent. Check the account ID, approved code hash, and policy mode.',
    }, null, 2);
    setStatus(error.message || 'Contract verification failed; the binding was not accepted.', 'error');
  } finally {
    verifyContractButton.disabled = !getSession();
  }
}

async function configureCircleScheduleParity(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before saving schedule expectations.', 'error');
    return;
  }
  const data = new FormData(scheduleParityForm);
  const circleId = String(data.get('circleId') ?? '').trim();
  const parseAccounts = value => String(value ?? '').split(',').map(account => account.trim()).filter(Boolean);
  const members = parseAccounts(data.get('members'));
  const payoutOrder = parseAccounts(data.get('payoutOrder'));
  const treasurerAgent = String(data.get('treasurerAgent') ?? '').trim();
  const validList = list => list.length >= 2 && list.length <= 100
    && list.every(account => /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(account))
    && new Set(list).size === list.length;
  if (!circleId || !validList(members) || !validList(payoutOrder)
      || payoutOrder.length !== members.length || payoutOrder.some(account => !members.includes(account))
      || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(treasurerAgent)) {
    setStatus('Enter unique valid NEAR accounts; payout order must contain every member exactly once.', 'error');
    return;
  }
  configureParityButton.disabled = true;
  scheduleParityResult.classList.remove('hidden');
  scheduleParityResult.textContent = 'Saving local expected contract schedule?';
  try {
    const result = await api('/api/circle/schedule-parity/configure', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId, members, payoutOrder, treasurerAgent }),
    });
    scheduleParityResult.textContent = JSON.stringify({
      schedule: result.schedule,
      quoteReady: result.quoteReady,
      note: result.note,
      nextStep: 'Run Verify contract on NEAR testnet again to compare these expectations with finalized on-chain state.',
    }, null, 2);
    contractVerifyForm.elements.circleId.value = circleId;
    policyPreviewForm.elements.circleId.value = circleId;
    setStatus('Expected schedule saved locally. Quotes remain blocked until exact on-chain parity passes.', 'success');
  } catch (error) {
    scheduleParityResult.textContent = JSON.stringify({ error: error.code ?? 'SCHEDULE_PARITY_CONFIGURE_FAILED', message: error.message }, null, 2);
    setStatus(error.message || 'Could not save expected schedule configuration.', 'error');
  } finally {
    configureParityButton.disabled = !getSession();
  }
}

async function importExistingOnChainCycle() {
  const session = getSession();
  if (!session) {
    setStatus('Sign in with the circle creator wallet before importing existing contract state.', 'error');
    return;
  }
  const circleId = String(importCycleCircleId.value || contractVerifyForm.elements.circleId.value || '').trim();
  if (!circleId) {
    setStatus('Enter the local circle ID before importing the existing contract lifecycle.', 'error');
    return;
  }
  importExistingCycleButton.disabled = true;
  cycleResult.classList.remove('hidden');
  cycleResult.textContent = 'Reading finalized NEAR testnet state and reconciling local cycle metadata…';
  try {
    const result = await api('/api/circle/cycle/import-verified', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId }),
    });
    cycleConfigureForm.elements.circleId.value = circleId;
    contractVerifyForm.elements.circleId.value = circleId;
    policyPreviewForm.elements.circleId.value = circleId;
    quoteForm.elements.circleId.value = circleId;
    nativeContributionForm.elements.circleId.value = circleId;
    payoutReadinessForm.elements.circleId.value = circleId;
    applyVerifiedCircleLifecycle(circleId, {
      verified: true,
      circleCompleted: result.binding?.circleCompleted,
      payoutPending: result.binding?.payoutPending,
      payoutComplete: result.binding?.payoutComplete,
      verifiedAt: result.binding?.verifiedAt,
    });
    cycleResult.textContent = JSON.stringify({
      imported: result.imported,
      cycle: result.cycle,
      onChainLifecycle: {
        verified: true,
        contractId: result.binding?.contractId,
        currentRound: result.binding?.currentRound,
        currentRecipient: result.binding?.currentRecipient,
        contributionCount: result.binding?.contributionCount,
        payoutPending: result.binding?.payoutPending,
        payoutComplete: result.binding?.payoutComplete,
        circleCompleted: result.binding?.circleCompleted,
        verifiedAt: result.binding?.verifiedAt,
      },
      quoteReady: result.quoteReady,
      quoteReadinessReason: result.binding?.quoteReadinessReason,
      parityMismatches: result.binding?.parityMismatches,
      verifiedAt: result.binding?.verifiedAt,
      note: result.note,
      safety: 'Local metadata only. No blockchain transaction, contribution, or payout was sent.',
    }, null, 2);
    setStatus(result.quoteReady
      ? 'Existing on-chain lifecycle reconciled locally and schedule parity passed.'
      : 'Existing on-chain lifecycle imported locally. Quotes remain blocked until all live safety checks pass.', 'info');
  } catch (error) {
    const creatorRequired = error.code === 'CIRCLE_CREATOR_REQUIRED';
    const detail = {
      error: error.code ?? 'CYCLE_IMPORT_REJECTED',
      message: creatorRequired
        ? `You are signed in as ${session.accountId}. This import is creator-only; sign out and reconnect the creator wallet${error.creatorAccountId ? ` (${error.creatorAccountId})` : ''}, then retry.`
        : error.message,
      ...(creatorRequired ? { currentWallet: session.accountId, requiredCreatorAccountId: error.creatorAccountId ?? null,
        nextStep: 'Use the wallet that originally created this circle. Do not change the creator authorization rule.' } : {}),
      safety: 'No blockchain transaction was sent.',
    };
    cycleResult.textContent = JSON.stringify(detail, null, 2);
    setStatus(detail.message || 'Could not safely import the existing contract lifecycle.', 'error');
  } finally {
    importExistingCycleButton.disabled = !getSession();
  }
}

async function configureCircleCycle(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before configuring a cycle.', 'error');
    return;
  }
  const data = new FormData(cycleConfigureForm);
  const circleId = String(data.get('circleId') ?? '').trim();
  const contributionAmount = String(data.get('contributionAmount') ?? '').trim();
  const memberCount = Number(data.get('memberCount'));
  const intervalMinutes = Number(data.get('intervalMinutes'));
  const firstDeadlineMs = Date.parse(String(data.get('firstDeadline') ?? ''));
  const exactDeadlineInput = String(data.get('exactDeadlinesNs') ?? '').trim();
  if (!circleId || !/^[1-9][0-9]*$/.test(contributionAmount)
      || !Number.isSafeInteger(memberCount) || memberCount < 2 || memberCount > 100) {
    setStatus('Enter a circle, positive base-unit amount, and a member/round count from 2 to 100.', 'error');
    return;
  }
  let rounds;
  if (exactDeadlineInput) {
    const deadlines = exactDeadlineInput.split(/[\s,]+/).filter(Boolean);
    if (deadlines.length !== memberCount || deadlines.some(value => !/^[1-9][0-9]*$/.test(value))) {
      setStatus('Enter exactly one positive nanosecond deadline for every round, in round order.', 'error');
      return;
    }
    const nowNs = BigInt(Date.now()) * 1000000n;
    let previousDeadlineNs = 0n;
    rounds = deadlines.map(deadlineNs => {
      const exactDeadline = BigInt(deadlineNs);
      const deadlineMs = Number(exactDeadline / 1000000n);
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || exactDeadline <= nowNs || exactDeadline <= previousDeadlineNs) return null;
      previousDeadlineNs = exactDeadline;
      return { contributionAmount, deadlineMs, deadlineNs };
    });
    if (rounds.some(round => round === null)) {
      setStatus('Exact deadlines must be future timestamps in strictly increasing order.', 'error');
      return;
    }
  } else {
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600
        || !Number.isSafeInteger(firstDeadlineMs) || firstDeadlineMs <= Date.now()) {
      setStatus('Without exact on-chain deadlines, enter a valid interval and future first deadline.', 'error');
      return;
    }
    const intervalMs = intervalMinutes * 60_000;
    rounds = Array.from({ length: memberCount }, (_, round) => {
      const deadlineMs = firstDeadlineMs + round * intervalMs;
      return { contributionAmount, deadlineMs, deadlineNs: String(BigInt(deadlineMs) * 1000000n) };
    });
    if (rounds.some(round => !Number.isSafeInteger(round.deadlineMs))) {
      setStatus('The generated schedule contains an invalid deadline timestamp.', 'error');
      return;
    }
  }
  configureCycleButton.disabled = true;
  cycleResult.classList.remove('hidden');
  cycleResult.textContent = 'Validating membership count and saving the complete round schedule…';
  try {
    const result = await api('/api/circle/cycle/configure', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId, rounds }),
    });
    cycleStatusLabel.textContent = result.cycle.status;
    cycleResult.textContent = JSON.stringify({
      status: result.cycle.status,
      plannedRounds: result.cycle.plannedRounds,
      activeMembers: result.cycle.activeMembers,
      configuredRounds: result.cycle.configuredRounds,
      policyVersion: result.cycle.policyVersion,
      ready: result.cycle.ready,
      roundDeadlinesNs: rounds.map((round, index) => ({ round: index, deadlineNs: round.deadlineNs })),
      note: 'Exact deadline values are stored locally. No blockchain transaction or funds moved.',
    }, null, 2);
    policyPreviewForm.elements.circleId.value = circleId;
    invitationForm.elements.circleId.value = circleId;
    setStatus('Round schedule saved. Each active member must accept the exact policy before the creator can start.', 'success');
    await refreshCycleStatus();
  } catch (error) {
    cycleResult.textContent = JSON.stringify({ error: error.code ?? 'CYCLE_CONFIGURE_FAILED', message: error.message }, null, 2);
    setStatus(error.message || 'Could not configure the cycle. Confirm every intended member has joined.', 'error');
  } finally {
    configureCycleButton.disabled = !getSession();
  }
}

async function previewCirclePolicy(event) {
  event?.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before previewing circle rules.', 'error');
    return;
  }
  const data = new FormData(policyPreviewForm);
  const circleId = String(data.get('circleId') ?? '').trim();
  const inviteToken = String(data.get('inviteToken') ?? '').trim();
  const payload = { circleId };
  if (inviteToken) payload.inviteToken = inviteToken;
  currentPolicy = null;
  currentInviteToken = null;
  policyPreviewCard.classList.add('hidden');
  policyResult.classList.remove('hidden');
  policyResult.textContent = 'Loading the current circle policy…';
  policyPreviewButton.disabled = true;
  try {
    const result = await api('/api/circle/policy/preview', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify(payload),
    });
    const policy = result.policy;
    if (!policy || typeof policy.circleId !== 'string' || !Number.isSafeInteger(policy.policyVersion)) {
      throw new Error('The server returned an incomplete circle policy.');
    }
    const expectedDistributionPolicy = policy.invitationOnly
      ? 'ROTATING_ROUND_RECIPIENT'
      : 'PROPORTIONAL_VERIFIED_CONTRIBUTIONS';
    if (policy.distributionPolicy !== expectedDistributionPolicy) {
      throw new Error('The policy is missing its required distribution rule. Joining is blocked until the server publishes the complete policy and distribution terms.');
    }
    currentPolicy = policy;
    currentInviteToken = inviteToken || null;
    policyModeTitle.textContent = policy.invitationOnly ? 'Private Trusted Circle' : 'Protected Public Circle';
    policyVersionLabel.textContent = `Policy v${policy.policyVersion}`;
    policyDescription.textContent = policy.invitationOnly
      ? 'Invitation-only trust-based circle with rotating payouts by round. The platform does not promise collateral or protection.'
      : 'Protected public policy. Public listings are not yet available in this prototype. This model distributes the final pool proportionally after whole-circle completion, not as rotating round payouts.';
    policyRuleList.replaceChildren();
    const rules = policy.invitationOnly ? [
      'This circle is invitation-only and is not listed publicly.',
      'The payout model is round-by-round rotation: the designated recipient for each round receives that round’s pot only after required contributions and payout checks are verified.',
      policy.shortfallPolicy === 'ALLOW_PARTIAL_PAYOUT'
        ? 'The accepted policy permits a partial payout if the pot is short; the amount collected and exact shortfall must remain visible.'
        : 'The round payout waits until the full pot has been collected.',
      'No platform-funded collateral, guarantee, mandatory protection reserve, or loss protection is promised by default.',
      `The payment grace period is ${policy.gracePeriodDays} days after a missed deadline.`,
    ] : [
      'This is a whole-circle completion model: no rotating round payout is made. Distribution waits until completion conditions are met and outstanding default/removal cases and disputes are resolved.',
      'The final distributable pool is divided proportionally among eligible members using each member’s verified contribution total. Shares are not equal by default.',
      'Share calculation: final distributable pool × a member’s verified contributions ÷ total verified contributions of all eligible members. Rounding is deterministic and every base unit must be allocated exactly once.',
      'Distribution is blocked if the pool balance, eligible-member status, or verified contribution totals cannot be established from authoritative evidence.',
      `The payment grace period is ${policy.gracePeriodDays} days after a missed deadline. A missed payment does not automatically remove a member; the required vote and review must be completed.`,
      `The proposed removal penalty is ${(policy.penaltyBps / 100).toFixed(2)}% of the eligible refundable balance after valid obligations, only after an approved vote and cleared review.`,
    ];
    for (const rule of rules) {
      const item = document.createElement('li');
      item.textContent = rule;
      policyRuleList.append(item);
    }
    policyAcceptance.checked = false;
    joinCircleButton.disabled = true;
    policyPreviewCard.classList.remove('hidden');
    policyResult.textContent = 'Policy loaded. Read the rules above before joining.';
    setStatus('Review the circle policy. Joining will record acceptance of this exact version.', 'success');
  } catch (error) {
    policyResult.textContent = JSON.stringify({ error: error.code ?? 'POLICY_PREVIEW_FAILED', message: error.message }, null, 2);
    setStatus(error.message || 'Could not load this circle policy.', 'error');
  } finally {
    policyPreviewButton.disabled = !getSession();
  }
}

async function joinCircle() {
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Sign in again before joining a circle.', 'error');
    return;
  }
  if (!currentPolicy || !policyAcceptance.checked) {
    setStatus('Preview the rules and confirm acceptance before joining.', 'error');
    return;
  }
  const payload = { circleId: currentPolicy.circleId, policyVersion: currentPolicy.policyVersion, accepted: true };
  if (currentPolicy.invitationOnly && currentInviteToken) payload.inviteToken = currentInviteToken;
  joinCircleButton.disabled = true;
  policyResult.classList.remove('hidden');
  policyResult.textContent = 'Recording policy acceptance and joining…';
  try {
    const result = await api('/api/circle/join', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify(payload),
    });
    policyResult.textContent = JSON.stringify({ status: 'joined', membership: result.membership, acceptedPolicyHash: result.acceptedPolicyHash }, null, 2);
    currentPolicy = null;
    currentInviteToken = null;
    policyAcceptance.checked = false;
    joinCircleButton.disabled = true;
    setStatus('Circle membership recorded. No contribution or payout was made.', 'success');
  } catch (error) {
    policyResult.textContent = JSON.stringify({ error: error.code ?? 'JOIN_FAILED', message: error.message }, null, 2);
    if (error.status === 409) {
      currentPolicy = null;
      policyPreviewCard.classList.add('hidden');
      setStatus('The circle policy changed. Preview the latest version before accepting it.', 'error');
    } else {
      setStatus(error.message || 'Could not join this circle.', 'error');
    }
  } finally {
    joinCircleButton.disabled = !currentPolicy || !policyAcceptance.checked;
  }
}

async function refreshCycleStatus() {
  const session = getSession();
  const circleId = String(policyPreviewForm.elements.circleId.value ?? '').trim();
  if (!session || !circleId) {
    setStatus('Sign in and enter the circle ID before checking cycle readiness.', 'error');
    return;
  }
  cycleStatusButton.disabled = true;
  cycleStartButton.disabled = true;
  cycleResult.classList.remove('hidden');
  cycleResult.textContent = 'Checking membership, policy acceptance, and round configuration…';
  try {
    const result = await api('/api/circle/cycle/status', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify({ circleId }),
    });
    currentCycle = result.cycle;
    cycleStatusLabel.textContent = currentCycle.status;
    cycleResult.textContent = JSON.stringify({
      status: currentCycle.status,
      activeMembers: currentCycle.activeMembers,
      acceptedMembers: currentCycle.acceptedMembers,
      plannedRounds: currentCycle.plannedRounds,
      configuredRounds: currentCycle.configuredRounds,
      policyVersion: currentCycle.policyVersion,
      readyForStart: currentCycle.status === 'DRAFT' && currentCycle.ready,
      cycleAlreadyStarted: currentCycle.status === 'STARTED',
      canStart: currentCycle.canStart,
      startedAt: currentCycle.startedAt,
    }, null, 2);
    cycleStartButton.disabled = !(currentCycle.status === 'DRAFT' && currentCycle.ready && currentCycle.canStart);
    if (currentCycle.status === 'STARTED') {
      setStatus('This cycle is already started. Do not start it again; continue with verified contract reconciliation and quote safeguards.', 'success');
    } else {
      setStatus(currentCycle.ready ? (currentCycle.canStart ? 'All cycle-start checks passed. You can start this cycle.' : 'All checks passed; only the circle creator can start this cycle.') : 'This cycle is not ready. Check member acceptance and round configuration.', currentCycle.ready ? 'success' : 'info');
    }
  } catch (error) {
    currentCycle = null;
    cycleStatusLabel.textContent = error.code === 'CYCLE_NOT_CONFIGURED' ? 'Not configured' : 'Unavailable';
    cycleResult.textContent = JSON.stringify({ error: error.code ?? 'CYCLE_STATUS_FAILED', message: error.message }, null, 2);
    setStatus(error.message || 'Could not check cycle readiness.', 'error');
  } finally {
    cycleStatusButton.disabled = !getSession();
  }
}

async function startCircleCycle() {
  const session = getSession();
  const circleId = String(policyPreviewForm.elements.circleId.value ?? '').trim();
  if (!session || !circleId || !currentCycle?.ready || !currentCycle?.canStart) {
    setStatus('Check readiness first. Only the creator may start a ready cycle.', 'error');
    return;
  }
  cycleStartButton.disabled = true;
  cycleStatusButton.disabled = true;
  cycleResult.classList.remove('hidden');
  cycleResult.textContent = 'Starting the configured cycle…';
  try {
    const result = await api('/api/circle/cycle/start', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify({ circleId }),
    });
    currentCycle = result.cycle;
    cycleStatusLabel.textContent = currentCycle.status;
    cycleResult.textContent = JSON.stringify({ status: currentCycle.status, startedAt: currentCycle.startedAt, policyVersion: currentCycle.policyVersion }, null, 2);
    cycleStartButton.disabled = true;
    setStatus('Cycle started in the local application store. This does not submit a blockchain transaction or move funds.', 'success');
  } catch (error) {
    cycleResult.textContent = JSON.stringify({ error: error.code ?? 'CYCLE_START_FAILED', message: error.message }, null, 2);
    setStatus(error.message || 'Cycle could not start. Refresh readiness and review the outstanding checks.', 'error');
    await refreshCycleStatus();
  } finally {
    cycleStatusButton.disabled = !getSession();
  }
}

async function createInvitation(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before creating an invitation.', 'error');
    return;
  }
  const data = new FormData(invitationForm);
  const payload = {
    circleId: String(data.get('circleId') ?? '').trim(),
    expiresInHours: Number(data.get('expiresInHours')),
    maxUses: Number(data.get('maxUses')),
  };
  createInvitationButton.disabled = true;
  invitationResult.classList.add('hidden');
  try {
    const result = await api('/api/circle/invitations', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify(payload),
    });
    const invitation = result.invitation;
    const link = new URL(window.location.pathname, window.location.origin);
    link.hash = new URLSearchParams({ circle: invitation.circleId, invite: invitation.token }).toString();
    invitationLink.value = link.toString();
    invitationResult.classList.remove('hidden');
    setStatus(`Invitation created. It expires ${new Date(invitation.expiresAtMs).toLocaleString()} and allows ${invitation.maxUses} use(s).`, 'success');
  } catch (error) {
    setStatus(error.message || 'Could not create a private invitation.', 'error');
  } finally {
    createInvitationButton.disabled = !getSession();
  }
}

async function copyInvitationLink() {
  if (!invitationLink.value) return;
  try {
    await navigator.clipboard.writeText(invitationLink.value);
    setStatus('Invitation link copied. Share it only with the people you trust.', 'success');
  } catch {
    invitationLink.focus();
    invitationLink.select();
    const copied = document.execCommand('copy');
    setStatus(copied ? 'Invitation link copied. Share it only with the people you trust.' : 'Select and copy the invitation link manually.', copied ? 'success' : 'error');
  }
}

async function revokeInvitation() {
  const session = getSession();
  if (!session || !invitationLink.value) {
    setStatus('Create an invitation link and sign in before revoking it.', 'error');
    return;
  }
  let circleId;
  let token;
  try {
    const link = new URL(invitationLink.value);
    const params = new URLSearchParams(link.hash.slice(1));
    circleId = params.get('circle');
    token = params.get('invite');
  } catch {
    setStatus('The invitation link could not be parsed.', 'error');
    return;
  }
  if (!circleId || !token) {
    setStatus('The invitation link is missing its circle or token.', 'error');
    return;
  }
  revokeInvitationButton.disabled = true;
  try {
    await api('/api/circle/invitations/revoke', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId, token }),
    });
    revokeInvitationButton.textContent = 'Invitation revoked';
    setStatus('Invitation revoked. Anyone who has not used it can no longer join with that link.', 'success');
  } catch (error) {
    revokeInvitationButton.disabled = false;
    setStatus(error.message || 'Could not revoke the invitation.', 'error');
  }
}

function loadInviteFromFragment() {
  if (!window.location.hash || window.location.hash.length < 2) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const circleId = params.get('circle');
  const inviteToken = params.get('invite');
  if (!circleId || !inviteToken) return false;
  policyPreviewForm.elements.circleId.value = circleId;
  policyPreviewForm.elements.inviteToken.value = inviteToken;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

async function checkPayoutReadiness(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before checking payout readiness.', 'error');
    return;
  }
  const circleId = String(new FormData(payoutReadinessForm).get('circleId') ?? '').trim();
  if (!circleId) {
    setStatus('Enter the circle ID to check payout readiness.', 'error');
    return;
  }
  payoutReadinessButton.disabled = true;
  payoutReadinessResult.classList.remove('hidden');
  payoutReadinessResult.textContent = 'Checking authenticated membership, approved contract binding, saved schedule, and finalized testnet state…';
  try {
    const result = await api('/api/agent/payout-readiness', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ circleId }),
    });
    payoutReadinessResult.textContent = JSON.stringify(result, null, 2);
    const readiness = result.readiness;
    const message = readiness?.status === 'ready'
      ? 'Read-only payout assessment is ready. No payout transaction was submitted.'
      : readiness?.reason || 'Payout is not ready. No transaction was submitted.';
    setStatus(message, readiness?.status === 'ready' ? 'success' : 'info');
  } catch (error) {
    payoutReadinessResult.textContent = JSON.stringify({
      status: 'PAYOUT_READINESS_UNAVAILABLE',
      error: error.code ?? 'PAYOUT_READINESS_FAILED',
      message: error.message,
      transactionSubmitted: false,
    }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('Your session expired. Sign in again before checking payout readiness.', 'error');
    } else {
      setStatus(error.message || 'Payout readiness could not be verified. No transaction was submitted.', 'error');
    }
  } finally {
    payoutReadinessButton.disabled = !getSession();
  }
}
async function preparePayoutPlan() {
  const session = getSession();
  if (!session) {
    setStatus('Sign in before preparing a payout plan.', 'error');
    return;
  }
  const circleId = String(new FormData(payoutReadinessForm).get('circleId') ?? '').trim();
  if (!circleId) {
    setStatus('Enter the circle ID and check payout readiness first.', 'error');
    payoutReadinessForm.elements.circleId.focus();
    return;
  }
  preparePayoutPlanButton.disabled = true;
  payoutPlanResult.classList.remove('hidden');
  payoutPlanResult.textContent = 'Rechecking fresh finalized testnet state and schedule parity before creating a plan. No transaction will be submitted.';
  try {
    const result = await api('/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ action: 'prepare', circleId }),
    });
    payoutPlanResult.textContent = JSON.stringify(result, null, 2);
    // Keep every downstream control bound to the freshly returned plan; never reuse stale round IDs.
    const preparedPlan = result.plan;
    if (preparedPlan?.id && preparedPlan?.contractId && Number.isSafeInteger(preparedPlan.round)) {
      for (const form of [payoutPlanStatusForm, payoutPlanAuthorizeForm, payoutPlanSubmitForm, payoutPlanFinalizeForm]) {
        if (form?.elements?.planId) form.elements.planId.value = preparedPlan.id;
      }
      if (payoutPlanAuthorizeForm?.elements?.confirmation) {
        payoutPlanAuthorizeForm.elements.confirmation.value = `AUTHORIZE TESTNET PAYOUT ${preparedPlan.contractId} ROUND ${preparedPlan.round}`;
      }
    }
    setStatus(result.plan?.state === 'PREPARED'
      ? 'Payout plan prepared for review only. No transaction was signed or submitted.'
      : result.readiness?.reason || 'Payout plan was not prepared. No transaction was submitted.',
    result.plan?.state === 'PREPARED' ? 'success' : 'info');
  } catch (error) {
    payoutPlanResult.textContent = JSON.stringify({
      status: 'PAYOUT_PLAN_NOT_PREPARED',
      error: error.code ?? 'PAYOUT_PLAN_FAILED',
      message: error.message,
      transactionSubmitted: false,
    }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('Your session expired. Sign in again before preparing a payout plan.', 'error');
    } else {
      setStatus(error.message || 'Payout plan was not prepared. No transaction was submitted.', 'error');
    }
  } finally {
    preparePayoutPlanButton.disabled = !getSession();
  }
}

async function checkPayoutPlanStatus(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in before checking payout plan status.', 'error');
    return;
  }
  const planId = String(new FormData(payoutPlanStatusForm).get('planId') ?? '').trim();
  if (!planId) {
    setStatus('Paste the plan ID returned by payout plan preparation.', 'error');
    return;
  }
  payoutPlanStatusButton.disabled = true;
  payoutPlanStatusResult.classList.remove('hidden');
  payoutPlanStatusResult.textContent = 'Reading the saved plan ledger only. No transaction will be submitted…';
  try {
    const result = await api('/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ action: 'status', planId }),
    });
    payoutPlanStatusResult.textContent = JSON.stringify(result, null, 2);
    setStatus('Payout plan status retrieved from the ledger. This does not verify chain finality or move funds.', 'info');
  } catch (error) {
    payoutPlanStatusResult.textContent = JSON.stringify({
      error: error.code ?? 'PAYOUT_PLAN_STATUS_FAILED',
      message: error.message,
      transactionSubmitted: false,
    }, null, 2);
    if (error.status === 401) {
      clearSession();
      setStatus('Your session expired. Sign in again before checking payout plan status.', 'error');
    } else {
      setStatus(error.message || 'Payout plan status could not be retrieved.', 'error');
    }
  } finally {
    payoutPlanStatusButton.disabled = !getSession();
  }
}

async function submitPayoutApproval(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    setStatus('Sign in with the second active member account before recording approval.', 'error');
    return;
  }
  const data = new FormData(payoutPlanAuthorizeForm);
  const planId = String(data.get('planId') ?? '').trim();
  const confirmation = String(data.get('confirmation') ?? '').trim();
  if (!planId || !confirmation) {
    setStatus('Enter the saved plan ID and confirmation phrase.', 'error');
    return;
  }
  authorizePayoutPlanButton.disabled = true;
  payoutPlanAuthorizeResult.classList.remove('hidden');
  payoutPlanAuthorizeResult.textContent = 'Verifying session and requesting approval-record update. No transaction will be sent.';
  try {
    const verified = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: 'Bearer ' + session.token },
    });
    if (verified.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different account. Sign in again.');
    }
    const result = await api('/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ action: 'authorize', planId, confirmation }),
    });
    payoutPlanAuthorizeResult.textContent = JSON.stringify(result, null, 2);
    setStatus(result.plan?.state === 'AUTHORIZED'
      ? 'Approval record updated. No transaction was signed or submitted.'
      : 'Approval record was not updated.', result.plan?.state === 'AUTHORIZED' ? 'success' : 'info');
  } catch (error) {
    payoutPlanAuthorizeResult.textContent = JSON.stringify({
      error: error.code ?? 'PAYOUT_APPROVAL_FAILED', message: error.message, transactionSubmitted: false,
    }, null, 2);
    if (error.status === 401) clearSession();
    setStatus(error.message || 'Approval record was not updated.', 'error');
  } finally {
    authorizePayoutPlanButton.disabled = !getSession();
  }
}

async function submitAuthorizedPayout(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Sign in with an active circle member account before starting payout preflight.', 'error');
    return;
  }
  const formData = new FormData(payoutPlanSubmitForm);
  const planId = String(formData.get('planId') ?? '').trim();
  const confirmedCheckbox = formData.get('confirmPayout') === 'on';
  if (!planId || !confirmedCheckbox) {
    setStatus('Enter the authorized plan ID and check the payout confirmation box.', 'error');
    return;
  }

  submitPayoutPlanButton.disabled = true;
  payoutPlanSubmitResult.classList.remove('hidden');
  payoutPlanSubmitResult.textContent = 'Rechecking authorization, exact testnet contract binding, payout readiness, and the designated treasurer wallet. No transaction has been sent…';
  let walletPromptOpened = false;
  let submittedHash = null;
  try {
    const verifiedSession = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    });
    if (verifiedSession.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different member account. Sign in again.');
    }

    const status = await api('/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ action: 'status', planId }),
    });
    const plan = status.plan;
    if (!plan || plan.state !== 'AUTHORIZED' || plan.network !== 'testnet') {
      throw new Error(`Payout plan must be AUTHORIZED on testnet. Current state: ${plan?.state ?? 'not found'}. No transaction was sent.`);
    }

    const bindingResult = await api('/api/circle/verify-contract', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId: plan.circleId }),
    });
    const binding = bindingResult.binding;
    if (bindingResult.quoteReady !== true || binding?.quoteReady !== true
        || binding.network !== 'testnet' || binding.contractId !== plan.contractId
        || binding.codeSha256 !== plan.codeSha256 || binding.verification?.treasurerAgent !== plan.contractId) {
      throw new Error('Fresh approved contract binding, code hash, or designated treasurer does not match the authorized plan. No transaction was sent.');
    }
    const bindingAge = Date.now() - Date.parse(binding.verifiedAt ?? '');
    if (!Number.isFinite(bindingAge) || bindingAge < 0 || bindingAge > 60_000) {
      throw new Error('Contract verification is stale. Run a fresh verification before payout. No transaction was sent.');
    }

    const readinessResult = await api('/api/agent/payout-readiness', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ circleId: plan.circleId }),
    });
    const readiness = readinessResult.readiness;
    const readinessAge = Date.now() - Date.parse(readinessResult.liveVerifiedAt ?? '');
    if (readiness?.status !== 'ready' || readinessResult.transactionSubmitted !== false
        || !Number.isFinite(readinessAge) || readinessAge < 0 || readinessAge > 60_000
        || readinessResult.codeSha256 !== plan.codeSha256
        || readiness.contractId !== plan.contractId
        || String(readiness.round) !== String(plan.round)
        || readiness.recipient !== plan.recipient
        || String(readiness.potYocto) !== String(plan.amountYocto)
        || readiness.missingCount !== 0) {
      throw new Error('Fresh payout readiness does not exactly match the authorized round, recipient, amount, and code hash. No transaction was sent.');
    }

    const amountNear = (BigInt(plan.amountYocto) / (10n ** 24n)).toString();
    const confirmationPhrase = `SUBMIT TESTNET PAYOUT ${plan.contractId} ROUND ${plan.round}`;
    const confirmed = window.confirm(
      `AjoCircle TESTNET PAYOUT REVIEW\n\nContract / signer: ${plan.contractId}\nMethod: release_payout()\nRound: ${plan.round}\nRecipient: ${plan.recipient}\nAmount: ${amountNear} NEAR (${plan.amountYocto} yoctoNEAR)\nCode hash: ${plan.codeSha256}\nNetwork: NEAR testnet\nSigner: existing local NEAR CLI keychain\n\nThis submits the exact payout transaction after server-side re-verification. Do not continue if any detail differs. Continue?`
    );
    if (!confirmed) {
      payoutPlanSubmitResult.textContent = JSON.stringify({ status: 'CANCELLED', planId, transactionSubmitted: false }, null, 2);
      setStatus('Payout cancelled before submission. No transaction was sent.');
      return;
    }

    walletPromptOpened = true; // From this point, a lost response must be treated as an unknown submission.
    payoutPlanSubmitResult.textContent = 'Final server-side testnet checks are running. If the response is lost, do not retry; check the plan and chain state first.';
    const submitResult = await api('/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ action: 'submitCli', planId, confirmation: confirmationPhrase }),
    });
    submittedHash = submitResult.plan?.txHash ?? submitResult.transactionEvidence?.txHash ?? null;
    payoutPlanSubmitResult.textContent = JSON.stringify(submitResult, null, 2);
    if (submitResult.plan?.state === 'SUBMITTED') {
      if (payoutPlanFinalizeForm?.elements?.planId) payoutPlanFinalizeForm.elements.planId.value = planId;
      setStatus('The testnet transaction was independently verified and recorded. Now verify payout completion; do not submit again.', 'success');
      return;
    }
    if (submitResult.plan?.state === 'UNKNOWN' || submitResult.status === 'UNKNOWN') {
      setStatus('Submission outcome is uncertain. Do not retry. Reconcile the exact transaction and on-chain lifecycle first.', 'error');
      return;
    }
    throw new Error(submitResult.message || 'CLI payout submission was blocked before a verified submission. Check the returned plan status before taking any further action.');

  } catch (error) {
    // A concrete non-2xx API response from a server-side preflight failure confirms
    // that this request was blocked before CLI submission. A lost network response
    // or an in-progress conflict remains uncertain and must not invite a retry.
    if (error.status && error.code !== 'PAYOUT_SUBMISSION_ALREADY_IN_PROGRESS') walletPromptOpened = false;
    payoutPlanSubmitResult.textContent = JSON.stringify({
      status: walletPromptOpened ? 'PAYOUT_NEEDS_RECONCILIATION' : 'PREFLIGHT_BLOCKED',
      error: error.code ?? 'PAYOUT_SUBMISSION_BLOCKED',
      message: error.message,
      transactionHash: submittedHash,
      transactionSubmitted: walletPromptOpened,
      instruction: walletPromptOpened ? 'Do not retry until checking the exact transaction status.' : 'No wallet transaction was submitted.',
    }, null, 2);
    if (error.status === 401) clearSession();
    setStatus(error.message || 'Payout preflight or submission failed.', 'error');
  } finally {
    submitPayoutPlanButton.disabled = !getSession();
  }
}

async function verifyPayoutFinality(event) {
  event.preventDefault();
  const session = getSession();
  if (!session) {
    clearSession();
    setStatus('Sign in with an active circle member account before checking payout completion.', 'error');
    return;
  }
  const planId = String(new FormData(payoutPlanFinalizeForm).get('planId') ?? '').trim();
  if (!planId) {
    setStatus('Enter the payout plan ID to verify.', 'error');
    return;
  }
  finalizePayoutPlanButton.disabled = true;
  payoutPlanFinalizeResult.classList.remove('hidden');
  payoutPlanFinalizeResult.textContent = 'Checking the recorded transaction, deployed contract code, and finalized on-chain payout lifecycle. This is read-only and will not submit another transaction…';
  try {
    const verifiedSession = await api('/api/auth/near/session', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    });
    if (verifiedSession.accountId !== session.accountId) {
      clearSession();
      throw new Error('The server verified a different member account. Sign in again.');
    }
    const result = await api('/api/agent/payout-plan', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ action: 'finalize', planId }),
    });
    payoutPlanFinalizeResult.textContent = JSON.stringify(result, null, 2);
    if (result.plan?.state === 'FINALIZED') {
      setStatus('Payout completion is independently verified on-chain.', 'success');
    } else {
      setStatus('The payout transaction is recorded but its completion is still pending. Do not submit again.', 'info');
    }
  } catch (error) {
    payoutPlanFinalizeResult.textContent = JSON.stringify({
      status: error.code ?? 'PAYOUT_FINALITY_CHECK_FAILED',
      message: error.message,
      instruction: 'This check does not submit a transaction. If the payout is not complete or evidence is unavailable, do not retry; reconcile the existing transaction first.',
    }, null, 2);
    if (error.status === 401) clearSession();
    setStatus(error.message || 'Payout finality could not be verified.', 'error');
  } finally {
    finalizePayoutPlanButton.disabled = !getSession();
  }
}

async function init() {
  connector = new NearConnector({ network: 'testnet', features: { signMessage: true, signInAndSignMessage: true, testnet: true } });
  connector.on('wallet:signInAndSignMessage', onSignedMessage);
  connector.on('wallet:signIn', async event => {
    if (event?.source === 'signInAndSignMessage') return;
    if (sessionStorage.getItem(CHALLENGE_KEY)) {
      failSigning('The selected wallet signed in but did not return a NEP-413 message signature. Choose a wallet that supports signMessage.');
    }
  });
  connectButton.addEventListener('click', startLogin);
  verifySessionButton.addEventListener('click', verifyCurrentSession);
  logoutButton.addEventListener('click', () => {
    clearTimeout(signatureTimeout);
    sessionStorage.removeItem(CHALLENGE_KEY);
    clearSession();
    setStatus('Signed out of this AjoCircle browser session.');
  });
  quoteForm.addEventListener('submit', requestQuote);
  void loadApprovedOriginAssets();
  quoteForm.elements.circleId.addEventListener('input', refreshQuoteAvailability);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshQuoteAvailability();
  });
  window.setInterval(refreshQuoteAvailability, 10_000);
  contributionStatusForm.addEventListener('submit', checkContributionStatus);
  contributionEvidenceForm.addEventListener('submit', submitContributionEvidence);
  nativeContributionForm.addEventListener('submit', submitNativeContribution);
  circleCreateForm.addEventListener('submit', createCircle);
  contractVerifyForm.addEventListener('submit', verifyCircleContract);
  scheduleParityForm.addEventListener('submit', configureCircleScheduleParity);
  cycleConfigureForm.addEventListener('submit', configureCircleCycle);
  importExistingCycleButton.addEventListener('click', importExistingOnChainCycle);
  policyPreviewForm.addEventListener('submit', previewCirclePolicy);
  policyPreviewForm.addEventListener('input', () => {
    currentPolicy = null;
    currentInviteToken = null;
    currentCycle = null;
    policyPreviewCard.classList.add('hidden');
    cycleResult.classList.add('hidden');
    cycleStatusLabel.textContent = 'Not checked';
    cycleStartButton.disabled = true;
    joinCircleButton.disabled = true;
  });
  policyAcceptance.addEventListener('change', () => {
    joinCircleButton.disabled = !currentPolicy || !policyAcceptance.checked;
  });
  joinCircleButton.addEventListener('click', joinCircle);
  cycleStatusButton.addEventListener('click', refreshCycleStatus);
  cycleStartButton.addEventListener('click', startCircleCycle);
  payoutReadinessForm.addEventListener('submit', checkPayoutReadiness);
  publicDistributionForm.addEventListener('submit', assessPublicDistribution);
  publicDistributionPrepareForm.addEventListener('submit', event => runPublicDistributionAction(event, 'prepare', publicDistributionPrepareForm, publicDistributionExecutionResult));
  publicDistributionAuthorizeForm.addEventListener('submit', event => runPublicDistributionAction(event, 'authorize', publicDistributionAuthorizeForm, publicDistributionExecutionResult));
  publicDistributionStartForm.addEventListener('submit', event => runPublicDistributionAction(event, 'start', publicDistributionStartForm, publicDistributionExecutionResult));
  publicDistributionContinueForm.addEventListener('submit', event => runPublicDistributionAction(event, 'continue', publicDistributionContinueForm, publicDistributionExecutionResult));
  publicDistributionStatusForm.addEventListener('submit', event => runPublicDistributionAction(event, 'status', publicDistributionStatusForm, publicDistributionExecutionStatus));
  preparePayoutPlanButton.addEventListener('click', preparePayoutPlan);
  payoutPlanStatusForm.addEventListener('submit', checkPayoutPlanStatus);
  payoutPlanAuthorizeForm.addEventListener('submit', submitPayoutApproval);
  payoutPlanSubmitForm.addEventListener('submit', submitAuthorizedPayout);
  payoutPlanFinalizeForm.addEventListener('submit', verifyPayoutFinality);
  invitationForm.addEventListener('submit', createInvitation);
  copyInvitationButton.addEventListener('click', copyInvitationLink);
  revokeInvitationButton.addEventListener('click', revokeInvitation);
  pendingInviteLoaded = loadInviteFromFragment();
  const session = getSession();
  if (session) {
    showSession(session);
    refreshQuoteAvailability();
    setStatus(`Session restored for this tab. Expires ${new Date(session.expiresAt).toLocaleTimeString()}.`, 'success');
    if (pendingInviteLoaded) {
      pendingInviteLoaded = false;
      void previewCirclePolicy();
    }
  }
  if (sessionStorage.getItem(CHALLENGE_KEY)) {
    signingFlowActive = true;
    connectButton.disabled = true;
    setStatus('Waiting for the wallet to return from message signing…');
    signatureTimeout = setTimeout(() => {
      if (sessionStorage.getItem(CHALLENGE_KEY)) failSigning('No signature response was received. The challenge may have expired; start again.');
    }, 120_000);
  }
}

nativeEvidenceStatusForm.addEventListener('submit', checkNativeEvidenceStatus);
init().catch(() => setStatus('Wallet connector could not initialize. Reload and try again.', 'error'));
