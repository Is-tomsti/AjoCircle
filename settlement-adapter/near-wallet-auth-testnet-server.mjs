import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearWalletAuthStore, createNearWalletAuthService, createHmacSessionTokenVerifier } from './near-wallet-auth.mjs';
import { createNearWalletAuthHandler } from './near-wallet-auth-handler.mjs';

const TESTNET_RPC = 'https://rpc.testnet.fastnear.com';
const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:5173';
const DEFAULT_DB_PATH = join(process.env.LOCALAPPDATA ?? homedir(), 'AjoCircle', 'ajo-auth-testnet.sqlite');

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

export async function startNearWalletAuthTestnetServer({ port = 8787 } = {}) {
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || TESTNET_RPC;
  if (rpcUrl !== TESTNET_RPC) throw new Error(`This local test server only permits ${TESTNET_RPC}`);
  const webOrigin = process.env.AJO_TESTNET_WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN;
  const recipient = process.env.AJO_AUTH_RECIPIENT?.trim() || webOrigin;
  if (recipient !== webOrigin || !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(webOrigin)) {
    throw new Error('Testnet auth server must use the exact 127.0.0.1 web origin as its fixed recipient');
  }
  const sessionSecret = requiredEnv('AJO_SESSION_SECRET');
  const dbPath = resolve(process.env.AJO_AUTH_DB_PATH?.trim() || DEFAULT_DB_PATH);
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new NearWalletAuthStore({ path: dbPath });
  const service = createNearWalletAuthService({
    store,
    rpcUrl,
    recipient,
    sessionSecret,
    issuer: 'ajo-circle-testnet-local',
    audience: 'ajo-circle-testnet-web',
    // Test-only policy: this isolated loopback server tests wallet ownership only.
    // It does not authorize circle membership or serve quotes.
    isAccountSuspended: async accountId => {
      const suspended = new Set((process.env.AJO_TESTNET_SUSPENDED_ACCOUNTS ?? '').split(',').map(value => value.trim()).filter(Boolean));
      return suspended.has(accountId);
    },
  });
  const verifySignedMessage = service.verifySignedMessage.bind(service);
  service.verifySignedMessage = async payload => {
    try {
      const session = await verifySignedMessage(payload);
      console.log('NEP-413 testnet verification accepted.');
      return session;
    } catch {
      console.log('NEP-413 testnet verification rejected.');
      throw new Error('WALLET_AUTH_REJECTED');
    }
  };
  const authHandler = createNearWalletAuthHandler({ service, challengeRateLimit: 10, challengeRateWindowMs: 60_000 });
  const verifyBearerToken = createHmacSessionTokenVerifier({
    sessionSecret,
    issuer: 'ajo-circle-testnet-local',
    audience: 'ajo-circle-testnet-web',
    isAccountSuspended: async accountId => {
      const suspended = new Set((process.env.AJO_TESTNET_SUSPENDED_ACCOUNTS ?? '').split(',').map(value => value.trim()).filter(Boolean));
      return suspended.has(accountId);
    },
  });

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && origin !== webOrigin) return sendJson(response, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    if (origin === webOrigin) {
      response.setHeader('access-control-allow-origin', webOrigin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      response.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
      response.setHeader('access-control-max-age', '600');
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = origin === webOrigin ? 204 : 403;
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/auth/near/challenge' || pathname === '/api/auth/near/verify') {
      await authHandler(request, response);
      return;
    }
    if (pathname === '/api/auth/near/session') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
      const session = match ? await verifyBearerToken(match[1]) : null;
      if (!session) return sendJson(response, 401, { error: 'SESSION_INVALID' });
      return sendJson(response, 200, { accountId: session.subject, expiresAt: new Date(session.expiresAtMs).toISOString() });
    }
    if (pathname === '/api/member/quote') {
      return sendJson(response, 503, { error: 'TESTNET_QUOTE_BACKEND_NOT_CONFIGURED' });
    }
    return sendJson(response, 404, { error: 'NOT_FOUND' });
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const cleanupTimer = setInterval(() => {
    try { store.deleteExpiredChallenges(Date.now()); } catch { /* keep the server alive; monitor cleanup failures in a real deployment */ }
  }, 60_000);
  cleanupTimer.unref();
  server.once('close', () => {
    clearInterval(cleanupTimer);
    store.close();
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const port = Number(process.env.AJO_TESTNET_AUTH_PORT ?? 8787);
    const server = await startNearWalletAuthTestnetServer({ port });
    console.log(`AjoCircle local auth test server listening at http://127.0.0.1:${server.address().port}`);
    console.log(`NEAR RPC: ${TESTNET_RPC}`);
    console.log('Testnet auth only; member quote endpoint returns 503 until real quote/membership services are configured.');
  } catch (error) {
    console.error(`AjoCircle testnet auth server failed to start: ${error.message}`);
    process.exitCode = 1;
  }
}
