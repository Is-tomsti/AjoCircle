import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearWalletAuthStore, createNearWalletAuthService, createHmacSessionTokenVerifier } from './near-wallet-auth.mjs';
import { createNearWalletAuthHandler } from './near-wallet-auth-handler.mjs';
import { createBearerSessionAuthenticator } from './session-auth-adapter.mjs';
import { ApplicationStore } from './application-store.mjs';
import { createApplicationContextResolvers } from './application-context-adapter.mjs';
import { SettlementStore } from './settlement-store.mjs';
import { OneClickQuoteClient, parseOneClickQuotePreview } from './oneclick-quote.mjs';
import { MockOneClickQuoteProvider } from './mock-oneclick-quote-provider.mjs';
import { createMemberQuoteHandler } from './member-quote-handler.mjs';
import { assertLivePreviewRequestAllowed } from './live-preview-safety.mjs';
import { createNearRefundWalletVerificationHandler } from './near-refund-wallet-verification-handler.mjs';
import { createNearRefundWalletRegistrationHandler } from './near-refund-wallet-registration-handler.mjs';
import { createCirclePolicyHandler } from './circle-policy-handler.mjs';
import { createCircleAssetConfigHandler } from './circle-asset-config-handler.mjs';
import { verifyAjoCircleContract } from './near-contract-verification.mjs';
import { compareCircleSchedule } from './contract-schedule-parity.mjs';
import { createAjoApiHandler } from './ajo-api-handler.mjs';
import { NearContractReadClient } from './near-contract-read-client.mjs';
import { createContributionStatusHandler } from './contribution-status-handler.mjs';
import { createNativeContributionStatusHandler } from './native-contribution-status-handler.mjs';
import { ContributionEvidenceStore } from './contribution-evidence-store.mjs';
import { MemberReputationStore } from './member-reputation-store.mjs';
import { createApplicationBackedContributionReputationIngestion } from './contribution-reputation-ingestion.mjs';
import { createContributionReputationHandler } from './contribution-reputation-handler.mjs';
import { createPayoutReadinessHandler } from './payout-readiness-handler.mjs';
import { PayoutExecutionStore } from './payout-execution-store.mjs';
import { createPayoutExecutionHandler } from './payout-execution-handler.mjs';
import { createNearCliPayoutSubmitter } from './near-cli-payout-submitter.mjs';
import { createPublicDistributionAssessmentHandler } from './public-distribution-assessment-handler.mjs';
import { PublicDistributionExecutionStore } from './public-distribution-execution-store.mjs';
import { createNearCliPublicDistributionSubmitter } from './near-cli-public-distribution-submitter.mjs';
import { createPublicDistributionExecutionHandler } from './public-distribution-execution-handler.mjs';

const TESTNET_RPC = 'https://rpc.testnet.fastnear.com';
const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:5173';
const DEFAULT_DATA_DIR = join(process.env.LOCALAPPDATA ?? homedir(), 'AjoCircle');
const DEFAULT_AUTH_DB = join(DEFAULT_DATA_DIR, 'ajo-auth-testnet.sqlite');
const DEFAULT_APPLICATION_DB = join(DEFAULT_DATA_DIR, 'ajo-application-testnet.sqlite');
const DEFAULT_SETTLEMENT_DB = join(DEFAULT_DATA_DIR, 'ajo-settlement-testnet.sqlite');
const DEFAULT_REPUTATION_DB = join(DEFAULT_DATA_DIR, 'ajo-reputation-testnet.sqlite');
const DEFAULT_EVIDENCE_DB = join(DEFAULT_DATA_DIR, 'ajo-contribution-evidence-testnet.sqlite');
const DEFAULT_PAYOUT_EXECUTION_DB = join(DEFAULT_DATA_DIR, 'ajo-payout-execution-testnet.sqlite');
const DEFAULT_PUBLIC_DISTRIBUTION_EXECUTION_DB = join(DEFAULT_DATA_DIR, 'ajo-public-distribution-execution-testnet.sqlite');

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

function requiredEnv(config, name) {
  const value = config[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function suspendedAccountPolicy(config) {
  return async accountId => {
    const suspended = new Set((config.AJO_TESTNET_SUSPENDED_ACCOUNTS ?? '')
      .split(',').map(value => value.trim()).filter(Boolean));
    return suspended.has(accountId);
  };
}

/**
 * Local/testnet-only composition. It never binds outside IPv4 loopback and
 * exposes no public route for privileged membership provisioning.
 */
export async function startAjoTestnetAppServer({ port = 8787, config = process.env, fetchImpl = globalThis.fetch } = {}) {
  const rpcUrl = config.NEAR_RPC_URL?.trim() || TESTNET_RPC;
  if (rpcUrl !== TESTNET_RPC) throw new Error(`This server only permits ${TESTNET_RPC}`);
  const webOrigin = config.AJO_TESTNET_WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN;
  const recipient = config.AJO_AUTH_RECIPIENT?.trim() || webOrigin;
  if (recipient !== webOrigin || !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(webOrigin)) {
    throw new Error('Testnet server requires the exact 127.0.0.1 frontend origin as its fixed NEP-413 recipient');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer between 0 and 65535');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is unavailable');

  const sessionSecret = requiredEnv(config, 'AJO_SESSION_SECRET');
  const authDbPath = resolve(config.AJO_AUTH_DB_PATH?.trim() || DEFAULT_AUTH_DB);
  const applicationDbPath = resolve(config.AJO_APPLICATION_DB_PATH?.trim() || DEFAULT_APPLICATION_DB);
  const settlementDbPath = resolve(config.AJO_SETTLEMENT_DB_PATH?.trim() || DEFAULT_SETTLEMENT_DB);
  const reputationDbPath = resolve(config.AJO_REPUTATION_DB_PATH?.trim() || DEFAULT_REPUTATION_DB);
  const evidenceDbPath = resolve(config.AJO_EVIDENCE_DB_PATH?.trim() || DEFAULT_EVIDENCE_DB);
  const payoutExecutionDbPath = resolve(config.AJO_PAYOUT_EXECUTION_DB_PATH?.trim() || DEFAULT_PAYOUT_EXECUTION_DB);
  const publicDistributionExecutionDbPath = resolve(config.AJO_PUBLIC_DISTRIBUTION_EXECUTION_DB_PATH?.trim() || DEFAULT_PUBLIC_DISTRIBUTION_EXECUTION_DB);
  if (new Set([authDbPath, applicationDbPath, settlementDbPath, reputationDbPath, evidenceDbPath, payoutExecutionDbPath, publicDistributionExecutionDbPath].map(path => path.toLowerCase())).size !== 7) {
    throw new Error('Auth, application, settlement, reputation, evidence, payout execution, and public distribution execution databases must use separate file paths');
  }
  await Promise.all([authDbPath, applicationDbPath, settlementDbPath, reputationDbPath, evidenceDbPath, payoutExecutionDbPath, publicDistributionExecutionDbPath]
    .map(path => mkdir(dirname(path), { recursive: true })));

  const isAccountSuspended = suspendedAccountPolicy(config);
  const authStore = new NearWalletAuthStore({ path: authDbPath });
  const applicationStore = new ApplicationStore({ path: applicationDbPath });
  const settlementStore = new SettlementStore({ path: settlementDbPath });
  const payoutExecutionStore = new PayoutExecutionStore({ path: payoutExecutionDbPath });
  const publicDistributionExecutionStore = new PublicDistributionExecutionStore({ path: publicDistributionExecutionDbPath });
  const evidenceStore = new ContributionEvidenceStore({ path: evidenceDbPath });
  const reputationStore = new MemberReputationStore({
    path: reputationDbPath,
    verifyEvidence: event => evidenceStore.verifyReference(event),
    authorizeReviewer: () => false,
  });
  let closed = false;
  const closeStores = () => {
    if (closed) return;
    closed = true;
    authStore.close();
    applicationStore.close();
    settlementStore.close();
    payoutExecutionStore.close();
    publicDistributionExecutionStore.close();
    reputationStore.close();
    evidenceStore.close();
  };

  try {
    const authService = createNearWalletAuthService({
      store: authStore,
      rpcUrl,
      recipient,
      sessionSecret,
      issuer: 'ajo-circle-testnet-local',
      audience: 'ajo-circle-testnet-web',
      fetchImpl,
      isAccountSuspended,
    });
    const authHandler = createNearWalletAuthHandler({
      service: authService,
      challengeRateLimit: 10,
      challengeRateWindowMs: 60_000,
    });
    const verifyBearerToken = createHmacSessionTokenVerifier({
      sessionSecret,
      issuer: 'ajo-circle-testnet-local',
      audience: 'ajo-circle-testnet-web',
      isAccountSuspended,
    });
    const authenticateRequest = createBearerSessionAuthenticator({ verifyBearerToken });
    const baseResolvers = createApplicationContextResolvers({
      repository: applicationStore,
      getPrincipalId: principal => principal.subject,
    });
    const resolvers = {
      ...baseResolvers,
      resolveTrustedContext: async args => {
        const circleId = typeof args?.circleId === 'string' ? args.circleId : '';
        const binding = circleId ? applicationStore.getVerifiedContractBinding({ circleId }) : null;
        // Every quote path requires a persisted verified binding. Local membership and
        // schedule records alone are not sufficient evidence of current contract state.
        if (!binding) return null;
        const trusted = await baseResolvers.resolveTrustedContext(args);
        const invalidate = reason => applicationStore.invalidateQuoteReadiness({ circleId, reason });
        if (!binding.quoteReady) return null;
        if (!trusted) {
          invalidate('Quote context or verification freshness is no longer valid. Repeat read-only contract verification; quotes remain blocked.');
          return null;
        }
        try {
          const parityContext = applicationStore.getCircleScheduleParityContext({ circleId });
          if (!parityContext?.ready || !parityContext.local
              || parityContext.local.contractId !== binding.contractId) {
            invalidate('Local schedule is no longer ready for trusted quote creation. Repeat schedule reconciliation and contract verification.');
            return null;
          }
          const live = await verifyAjoCircleContract({
            contractId: binding.contractId,
            expectedMode: parityContext.local.mode,
            rpcUrl,
            fetchImpl,
          });
          const ageMs = Date.now() - Date.parse(live.verifiedAt);
          const parity = compareCircleSchedule({ local: parityContext.local, onChain: live });
          const sameSnapshot = live.contractId === binding.contractId
            && live.network === 'testnet'
            && live.codeSha256 === binding.codeSha256
            && live.mode === binding.mode
            && live.currentRound === binding.currentRound
            && live.roundDeadline === binding.roundDeadline
            && live.contributionCount === binding.contributionCount
            && live.currentRecipient === binding.currentRecipient
            && live.circleCompleted === false
            && live.payoutPending === false
            && live.payoutComplete === false;
          if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 60_000 || !sameSnapshot || !parity.matches
              || live.currentRound !== args.round) {
            invalidate('Live contract state changed or no longer matches the verified local schedule. Refresh read-only verification before requesting another quote.');
            return null;
          }
          return trusted;
        } catch {
          invalidate('Live contract verification is unavailable or failed. Quote creation remains blocked until verification succeeds.');
          return null;
        }
      },
    };

    const oneClickToken = config.ONECLICK_API_TOKEN?.trim();
    const quoteBackendConfigured = Boolean(oneClickToken);
    const allowLiveOneClickPreview = config.AJO_TESTNET_ALLOW_LIVE_1CLICK_PREVIEW === 'true';
    const offlineMockPreviewEnabled = config.AJO_TESTNET_PREVIEW_PROVIDER === 'offline-mock';
    const liveOneClickClient = new OneClickQuoteClient({ ...(oneClickToken ? { bearerToken: oneClickToken } : {}), fetchImpl });
    const offlineMockProvider = new MockOneClickQuoteProvider();
    // 1Click is live/mainnet infrastructure, not a NEAR testnet simulator. The
    // offline mock is opt-in, preview-only, and visibly synthetic; committed quotes
    // always use the real credential-gated client and never the mock provider.
    const quoteClient = {
      getQuote: request => liveOneClickClient.getQuote(request),
      getQuotePreview: async request => {
        if (request?.dry !== true) throw new Error('Preview requests must set dry=true.');
        if (offlineMockPreviewEnabled) {
          return parseOneClickQuotePreview(await offlineMockProvider.getQuotePreview(request), request);
        }
        if (!allowLiveOneClickPreview) {
          throw new Error('Live 1Click preview is disabled in the testnet app; use the offline mock or a separately prepared live context.');
        }
        // 1Click prices/routes live assets, not NEAR testnet assets. Never send a
        // testnet recipient or refund account to live infrastructure, even with dry:true.
        assertLivePreviewRequestAllowed(request);
        return liveOneClickClient.getQuotePreview(request);
      },
    };
    const memberQuoteHandler = createMemberQuoteHandler({
      store: settlementStore,
      quoteClient,
      authenticateRequest,
      quoteBackendConfigured,
      ...resolvers,
      onError: details => console.error('[AjoCircle quote diagnostic]', JSON.stringify(details)),
    });
    const nearRefundWalletVerificationHandler = createNearRefundWalletVerificationHandler({
      store: applicationStore,
      authenticateRequest,
    });
    const nearRefundWalletRegistrationHandler = createNearRefundWalletRegistrationHandler({
      store: applicationStore,
      authenticateRequest,
    });
    const circlePolicyHandler = createCirclePolicyHandler({
      store: applicationStore,
      authenticateRequest,
      // Full contract verification fans out to many finalized read-only RPC calls.
      // Allow slower testnet RPC responses more time instead of failing at 10 seconds.
      verifyContract: args => verifyAjoCircleContract({ ...args, rpcUrl, fetchImpl, timeoutMs: 25_000 }),
    });
    const circleAssetConfigHandler = createCircleAssetConfigHandler({
      store: applicationStore,
      authenticateRequest,
      // Explicit server-side allowlist only. Empty/missing config fails closed.
      allowedAssetIds: (config.AJO_TESTNET_ALLOWED_ORIGIN_ASSETS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    });
    const contributionStatusHandler = createContributionStatusHandler({
      store: settlementStore,
      authorizeIntent: async (request, intent) => {
        const principal = await authenticateRequest(request);
        if (!principal) return false;
        const membership = applicationStore.findMembershipForPrincipal({
          principalId: principal.subject,
          circleId: intent.circleId,
        });
        return Boolean(membership && membership.memberId === intent.memberId);
      },
      resolveContractClient: async ({ intent }) => {
        const binding = applicationStore.getVerifiedContractBinding({ circleId: intent.circleId });
        const parity = applicationStore.getCircleScheduleParityContext({ circleId: intent.circleId });
        if (!binding || binding.network !== 'testnet' || !binding.contractId
            || !parity?.local || parity.local.contractId !== binding.contractId
            || !['PROTECTED_PUBLIC', 'PRIVATE_TRUSTED'].includes(parity.local.mode)) {
          throw new Error('A verified contract binding for this stored circle is required');
        }
        const verified = await verifyAjoCircleContract({
          contractId: binding.contractId,
          expectedMode: parity.local.mode,
          rpcUrl,
          fetchImpl,
        });
        if (verified.codeSha256 !== binding.codeSha256 || verified.mode !== binding.mode) {
          throw new Error('Current deployed contract no longer matches the approved circle binding');
        }
        return new NearContractReadClient({ rpcUrl, contractId: binding.contractId, fetchImpl });
      },
    });

    const nativeContributionStatusHandler = createNativeContributionStatusHandler({
      authenticateRequest,
      applicationStore,
      evidenceStore,
      resolveContractClient: async ({ circleId, binding }) => {
        const parity = applicationStore.getCircleScheduleParityContext({ circleId });
        if (!parity?.local || parity.local.contractId !== binding.contractId
            || !['PROTECTED_PUBLIC', 'PRIVATE_TRUSTED'].includes(parity.local.mode)) {
          throw new Error('Verified local contract schedule is required');
        }
        const live = await verifyAjoCircleContract({
          contractId: binding.contractId,
          expectedMode: parity.local.mode,
          rpcUrl,
          fetchImpl
        });
        if (live.network !== 'testnet'
            || live.codeSha256 !== binding.codeSha256
            || live.mode !== binding.mode) {
          throw new Error('Live contract does not match the approved binding');
        }
        return new NearContractReadClient({
          rpcUrl, contractId: binding.contractId, fetchImpl
        });
      }
    });

    const fallbackHandler = async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== '/api/auth/near/session') {
        return sendJson(response, 404, { error: 'NOT_FOUND' });
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      }
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
      const session = match ? await verifyBearerToken(match[1]) : null;
      if (!session) return sendJson(response, 401, { error: 'SESSION_INVALID' });
      return sendJson(response, 200, {
        accountId: session.subject,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      });
    };

    const contributionReputationIngestion = createApplicationBackedContributionReputationIngestion({
      applicationStore, reputationStore, evidenceStore,
      getPrincipalId: principal => principal.subject,
      fetchImpl,
    });
    const contributionReputationHandler = createContributionReputationHandler({
      authenticateRequest, ingestion: contributionReputationIngestion,
    });
    const payoutReadinessHandler = createPayoutReadinessHandler({
      store: applicationStore, authenticateRequest, rpcUrl, fetchImpl,
      verifyContract: args => verifyAjoCircleContract({ ...args, rpcUrl, fetchImpl }),
    });
    const submitPayout = createNearCliPayoutSubmitter({ fetchImpl, rpcUrl });
    const payoutExecutionHandler = createPayoutExecutionHandler({
      store: applicationStore,
      executionStore: payoutExecutionStore,
      authenticateRequest,
      submitPayout,
      rpcUrl,
      fetchImpl,
      verifyContract: args => verifyAjoCircleContract({ ...args, rpcUrl, fetchImpl, timeoutMs: 25_000 }),
    });
    const publicDistributionAssessmentHandler = createPublicDistributionAssessmentHandler({
      store: applicationStore, authenticateRequest, rpcUrl, fetchImpl,
      verifyContract: args => verifyAjoCircleContract({ ...args, rpcUrl, fetchImpl, timeoutMs: 25_000 }),
    });
    const submitPublicDistribution = createNearCliPublicDistributionSubmitter({ fetchImpl, rpcUrl });
    const publicDistributionExecutionHandler = createPublicDistributionExecutionHandler({
      store: applicationStore, executionStore: publicDistributionExecutionStore,
      authenticateRequest, submitDistribution: submitPublicDistribution, rpcUrl, fetchImpl,
      verifyContract: args => verifyAjoCircleContract({ ...args, rpcUrl, fetchImpl, timeoutMs: 25_000 }),
    });
    const apiHandler = createAjoApiHandler({
      authHandler, memberQuoteHandler, nearRefundWalletVerificationHandler, nearRefundWalletRegistrationHandler, contributionStatusHandler,
      nativeContributionStatusHandler, contributionReputationHandler,
      circlePolicyHandler, circleAssetConfigHandler, payoutReadinessHandler, payoutExecutionHandler, publicDistributionAssessmentHandler, publicDistributionExecutionHandler, fallbackHandler,
    });
    const server = createServer((request, response) => {
      Promise.resolve().then(async () => {
        const origin = request.headers.origin;
        if (origin && origin !== webOrigin) return sendJson(response, 403, { error: 'ORIGIN_NOT_ALLOWED' });
        if (origin === webOrigin) {
          response.setHeader('access-control-allow-origin', webOrigin);
          response.setHeader('vary', 'Origin');
          response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
          response.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
          response.setHeader('access-control-max-age', '600');
        }
        if (request.method === 'OPTIONS') {
          response.statusCode = origin === webOrigin ? 204 : 403;
          response.end();
          return;
        }
        await apiHandler(request, response);
      }).catch(() => {
        if (response.headersSent || response.writableEnded) {
          response.destroy();
          return;
        }
        sendJson(response, 500, { error: 'INTERNAL_ERROR' });
      });
    });

    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    const cleanupTimer = setInterval(() => {
      try { authStore.deleteExpiredChallenges(Date.now()); } catch { /* local test server stays fail-closed; production needs monitored cleanup */ }
    }, 60_000);
    cleanupTimer.unref();
    server.once('close', () => {
      clearInterval(cleanupTimer);
      closeStores();
    });
    server.once('error', closeStores);
    server.ajoTestnetConfig = Object.freeze({
      quoteBackendConfigured,
      applicationDbPath,
      settlementDbPath,
    });
    return server;
  } catch (error) {
    closeStores();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const port = Number(process.env.AJO_TESTNET_AUTH_PORT ?? 8787);
    const server = await startAjoTestnetAppServer({ port });
    console.log(`AjoCircle testnet app server listening at http://127.0.0.1:${server.address().port}`);
    console.log(`NEAR RPC: ${TESTNET_RPC}`);
    console.log(`1Click quote backend configured: ${server.ajoTestnetConfig.quoteBackendConfigured}`);
    console.log('Membership must be provisioned through trusted server-side operations; no public provisioning endpoint exists.');
    console.log('Testnet only. Payout submission requires an authenticated active member, an AUTHORIZED plan, fresh server-side checks, a matching on-chain FullAccess CLI key, and explicit app confirmation. No mainnet submission path exists.');
  } catch (error) {
    console.error(`AjoCircle testnet app server failed to start: ${error.message}`);
    process.exitCode = 1;
  }
}
