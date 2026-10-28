import { Buffer } from 'node:buffer';

export const CONTRIBUTION_REPUTATION_ENDPOINT_PATH =
  '/api/member/contribution-evidence';

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_JSON');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_BODY');
  }
  return value;
}

export function createContributionReputationHandler({
  authenticateRequest,
  ingestion,
  maxBodyBytes = 4096,
} = {}) {
  if (typeof authenticateRequest !== 'function') {
    throw new Error('Trusted request authentication is required');
  }
  if (typeof ingestion?.ingest !== 'function') {
    throw new Error('Trusted ingestion service is required');
  }

  return async function contributionReputationHandler(request, response) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let principal;
    try {
      principal = await authenticateRequest(request);
    } catch {
      principal = null;
    }
    if (!principal) return send(response, 401, { error: 'UNAUTHENTICATED' });

    let body;
    try {
      body = await readBody(request, maxBodyBytes);
    } catch (error) {
      return send(
        response,
        error.message === 'BODY_TOO_LARGE' ? 413 : 400,
        { error: error.message === 'BODY_TOO_LARGE'
          ? 'BODY_TOO_LARGE' : 'INVALID_BODY' },
      );
    }

    const keys = Object.keys(body).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== 'circleId' ||
      keys[1] !== 'round' ||
      keys[2] !== 'transactionHash' ||
      typeof body.circleId !== 'string' ||
      !body.circleId.trim() ||
      !Number.isSafeInteger(body.round) ||
      body.round < 0 ||
      typeof body.transactionHash !== 'string' ||
      !body.transactionHash.trim()
    ) {
      return send(response, 400, { error: 'INVALID_BODY' });
    }

    try {
      const result = await ingestion.ingest({
        principal,
        circleId: body.circleId.trim(),
        round: body.round,
        transactionHash: body.transactionHash.trim(),
      });
      return send(response, 200, result);
    } catch (error) {
      const message = String(error?.message ?? '');

      if (/UNIQUE constraint|already exists/i.test(message)) {
        return send(response, 409, { error: 'EVIDENCE_ALREADY_RECORDED' });
      }
      if (/membership|principal|context|active/i.test(message)) {
        return send(response, 403, { error: 'CONTRIBUTION_NOT_ELIGIBLE' });
      }
      if (/evidence|transaction|round|deposit|finalized|contribute|deadline|indexer|block|contract|signer|verified/i.test(message)) {
        return send(response, 422, { error: 'CONTRIBUTION_EVIDENCE_REJECTED' });
      }

      console.error('[AjoCircle reputation ingestion]', message);
      return send(response, 500, { error: 'INGESTION_UNAVAILABLE' });
    }
  };
}
