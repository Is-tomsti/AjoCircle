import { CONTRIBUTION_REPUTATION_ENDPOINT_PATH } from './contribution-reputation-handler.mjs';
import { PAYOUT_READINESS_PATH } from './payout-readiness-handler.mjs';
import { PAYOUT_EXECUTION_PLAN_PATH } from './payout-execution-handler.mjs';
import { NEAR_WALLET_CHALLENGE_PATH, NEAR_WALLET_VERIFY_PATH } from './near-wallet-auth-handler.mjs';
import { MEMBER_QUOTE_ENDPOINT_PATH, MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH } from './member-quote-handler.mjs';
import { NEAR_REFUND_WALLET_VERIFY_PATH } from './near-refund-wallet-verification-handler.mjs';
import { NEAR_REFUND_WALLET_REGISTER_PATH } from './near-refund-wallet-registration-handler.mjs';
import { CONTRIBUTION_STATUS_ENDPOINT_PATH } from './contribution-status-handler.mjs';
import { PUBLIC_DISTRIBUTION_ASSESSMENT_PATH } from './public-distribution-assessment-handler.mjs';
import { PUBLIC_DISTRIBUTION_EXECUTION_PATH } from './public-distribution-execution-handler.mjs';
import { NATIVE_CONTRIBUTION_STATUS_ENDPOINT_PATH } from './native-contribution-status-handler.mjs';
import { CIRCLE_ASSET_CONFIGURE_PATH, CIRCLE_ASSET_CATALOG_PATH } from './circle-asset-config-handler.mjs';
import { CIRCLE_CREATE_PATH, CIRCLE_CONTRACT_VERIFY_PATH, CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, CIRCLE_POLICY_PREVIEW_PATH, CIRCLE_JOIN_PATH, CIRCLE_INVITATION_PATH, CIRCLE_INVITATION_REVOKE_PATH, CIRCLE_CYCLE_STATUS_PATH, CIRCLE_CYCLE_CONFIGURE_PATH, CIRCLE_CYCLE_IMPORT_PATH, CIRCLE_CYCLE_START_PATH } from './circle-policy-handler.mjs';

function notFound(response) {
  response.statusCode = 404;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify({ error: 'NOT_FOUND' }));
}

/** Compose auth and member-quote handlers behind one HTTP server without weakening either handler's checks. */
export function createAjoApiHandler({ authHandler, memberQuoteHandler, nearRefundWalletVerificationHandler, nearRefundWalletRegistrationHandler, contributionStatusHandler, nativeContributionStatusHandler, contributionReputationHandler, circlePolicyHandler, circleAssetConfigHandler, payoutReadinessHandler, payoutExecutionHandler, publicDistributionAssessmentHandler, publicDistributionExecutionHandler, fallbackHandler } = {}) {
  if (typeof authHandler !== 'function') throw new Error('A NEAR wallet auth handler is required');
  if (typeof memberQuoteHandler !== 'function') throw new Error('A member quote handler is required');
  if (nearRefundWalletVerificationHandler !== undefined && typeof nearRefundWalletVerificationHandler !== 'function') throw new Error('Refund wallet verification handler must be a function');
  if (nearRefundWalletRegistrationHandler !== undefined && typeof nearRefundWalletRegistrationHandler !== 'function') throw new Error('Refund wallet registration handler must be a function');
  if (contributionStatusHandler !== undefined && typeof contributionStatusHandler !== 'function') throw new Error('Contribution status handler must be a function');
  if (nativeContributionStatusHandler !== undefined && typeof nativeContributionStatusHandler !== 'function') throw new Error('Native contribution status handler must be a function');
  if (contributionReputationHandler !== undefined && typeof contributionReputationHandler !== 'function') throw new Error('Contribution reputation handler must be a function');
  if (circlePolicyHandler !== undefined && typeof circlePolicyHandler !== 'function') throw new Error('Circle policy handler must be a function');
  if (circleAssetConfigHandler !== undefined && typeof circleAssetConfigHandler !== 'function') throw new Error('Circle asset config handler must be a function');
  if (payoutReadinessHandler !== undefined && typeof payoutReadinessHandler !== 'function') throw new Error('Payout readiness handler must be a function');
  if (payoutExecutionHandler !== undefined && typeof payoutExecutionHandler !== 'function') throw new Error('Payout execution handler must be a function');
  if (publicDistributionAssessmentHandler !== undefined && typeof publicDistributionAssessmentHandler !== 'function') throw new Error('Public distribution assessment handler must be a function');
  if (publicDistributionExecutionHandler !== undefined && typeof publicDistributionExecutionHandler !== 'function') throw new Error('Public distribution execution handler must be a function');
  if (fallbackHandler !== undefined && typeof fallbackHandler !== 'function') throw new Error('Fallback handler must be a function');
  return async function ajoApiHandler(request, response) {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { response.statusCode = 400; response.end(JSON.stringify({ error: 'INVALID_REQUEST' })); return; }
    if (pathname === NEAR_WALLET_CHALLENGE_PATH || pathname === NEAR_WALLET_VERIFY_PATH) return authHandler(request, response);
    if (pathname === MEMBER_QUOTE_ENDPOINT_PATH || pathname === MEMBER_QUOTE_PREVIEW_ENDPOINT_PATH) return memberQuoteHandler(request, response);
    if (nearRefundWalletVerificationHandler && pathname === NEAR_REFUND_WALLET_VERIFY_PATH) return nearRefundWalletVerificationHandler(request, response);
    if (nearRefundWalletRegistrationHandler && pathname === NEAR_REFUND_WALLET_REGISTER_PATH) return nearRefundWalletRegistrationHandler(request, response);
    if (contributionStatusHandler && pathname === CONTRIBUTION_STATUS_ENDPOINT_PATH) return contributionStatusHandler(request, response);
    if (nativeContributionStatusHandler && pathname === NATIVE_CONTRIBUTION_STATUS_ENDPOINT_PATH) return nativeContributionStatusHandler(request, response);
    if (contributionReputationHandler && pathname === CONTRIBUTION_REPUTATION_ENDPOINT_PATH) return contributionReputationHandler(request, response);
    if (circleAssetConfigHandler && [CIRCLE_ASSET_CONFIGURE_PATH, CIRCLE_ASSET_CATALOG_PATH].includes(pathname)) return circleAssetConfigHandler(request, response);
    if (payoutReadinessHandler && pathname === PAYOUT_READINESS_PATH) return payoutReadinessHandler(request, response);
    if (payoutExecutionHandler && pathname === PAYOUT_EXECUTION_PLAN_PATH) return payoutExecutionHandler(request, response);
    if (publicDistributionAssessmentHandler && pathname === PUBLIC_DISTRIBUTION_ASSESSMENT_PATH) return publicDistributionAssessmentHandler(request, response);
    if (publicDistributionExecutionHandler && pathname === PUBLIC_DISTRIBUTION_EXECUTION_PATH) return publicDistributionExecutionHandler(request, response);
    if (circlePolicyHandler && [CIRCLE_CREATE_PATH, CIRCLE_CONTRACT_VERIFY_PATH, CIRCLE_SCHEDULE_PARITY_CONFIGURE_PATH, CIRCLE_POLICY_PREVIEW_PATH, CIRCLE_JOIN_PATH, CIRCLE_INVITATION_PATH, CIRCLE_INVITATION_REVOKE_PATH, CIRCLE_CYCLE_STATUS_PATH, CIRCLE_CYCLE_CONFIGURE_PATH, CIRCLE_CYCLE_IMPORT_PATH, CIRCLE_CYCLE_START_PATH].includes(pathname)) {
      return circlePolicyHandler(request, response);
    }
    if (fallbackHandler) return fallbackHandler(request, response);
    return notFound(response);
  };
}
