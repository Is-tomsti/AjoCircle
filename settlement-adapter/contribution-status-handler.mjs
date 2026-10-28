import { getMemberContributionStatus } from './contribution-status.mjs';

const ENDPOINT_PATH = '/api/member/contribution-status';

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(payload);
}

/**
 * Create a Node.js HTTP handler for the authenticated member status endpoint.
 * `authorizeIntent(request, storedIntent)` must verify the authenticated caller
 * owns/is allowed to view this exact stored intent. It must return true only
 * after checking trusted identity and circle membership/permissions.
 */
export function createContributionStatusHandler({ store, contractClient, resolveContractClient, authorizeIntent } = {}) {
  if (!store || typeof store.getIntent !== 'function') throw new Error('A trusted settlement store is required');
  if (!contractClient && typeof resolveContractClient !== 'function') throw new Error('A NEAR contract read client or trusted client resolver is required');
  if (contractClient && typeof resolveContractClient === 'function') throw new Error('Provide either a fixed contract client or a trusted client resolver, not both');
  if (typeof authorizeIntent !== 'function') throw new Error('A trusted intent authorization callback is required');

  return async function contributionStatusHandler(request, response) {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    if (url.pathname !== ENDPOINT_PATH) return sendJson(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    const intentId = url.searchParams.get('intentId');
    if (!intentId || !intentId.trim() || intentId.length > 200) return sendJson(response, 400, { error: 'INVALID_INTENT_ID' });

    let intent;
    try {
      intent = store.getIntent(intentId.trim());
    } catch {
      return sendJson(response, 503, { error: 'STATUS_UNAVAILABLE' });
    }
    if (!intent) return sendJson(response, 404, { error: 'INTENT_NOT_FOUND' });

    let authorized = false;
    try {
      authorized = await authorizeIntent(request, intent) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) return sendJson(response, 403, { error: 'FORBIDDEN' });

    try {
      const client = resolveContractClient ? await resolveContractClient({ request, intent }) : contractClient;
      if (!client) throw new Error('Trusted contract client resolution failed');
      const status = await getMemberContributionStatus({ store, contractClient: client, intentId: intent.intentId });
      return sendJson(response, 200, { status });
    } catch {
      return sendJson(response, 503, { error: 'STATUS_UNAVAILABLE' });
    }
  };
}

export { ENDPOINT_PATH as CONTRIBUTION_STATUS_ENDPOINT_PATH };
