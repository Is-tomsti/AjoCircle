export const CIRCLE_ASSET_CONFIGURE_PATH = '/api/circle/assets/configure';
export const CIRCLE_ASSET_CATALOG_PATH = '/api/circle/assets/available';
const AMOUNT_RE = /^[1-9][0-9]*$/;

const KNOWN_ASSET_LABELS = new Map([
  ['nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'USDC (NEAR, 6 decimals)'],
  ['nep141:usdt.tether-token.near', 'USDT (NEAR, 6 decimals)'],
  ['nep141:wrap.near', 'Wrapped NEAR (wNEAR, 24 decimals)'],
]);

function assetLabel(id) {
  return KNOWN_ASSET_LABELS.get(id) ?? id;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8') > 16384) throw new Error('BODY_TOO_LARGE');
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(raw, 'utf8') > 16384) throw new Error('BODY_TOO_LARGE');
  }
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}

export function createCircleAssetConfigHandler({ store, authenticateRequest, allowedAssetIds = [] } = {}) {
  if (!store || typeof store.findMembershipForPrincipal !== 'function'
      || typeof store.getCircleCreatorAccount !== 'function'
      || typeof store.setCircleAsset !== 'function') throw new Error('A trusted application store is required');
  if (typeof authenticateRequest !== 'function') throw new Error('A trusted request authenticator is required');
  if (!Array.isArray(allowedAssetIds) || allowedAssetIds.some(x => typeof x !== 'string' || !x.trim())) {
    throw new Error('allowedAssetIds must contain non-empty strings');
  }
  const allowlist = new Set(allowedAssetIds.map(x => x.trim()));

  return async function circleAssetConfigHandler(req, res) {
    let path;
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; }
    catch { return sendJson(res, 400, { error: 'INVALID_REQUEST' }); }
    if (path !== CIRCLE_ASSET_CONFIGURE_PATH && path !== CIRCLE_ASSET_CATALOG_PATH) return sendJson(res, 404, { error: 'NOT_FOUND' });
    if (path === CIRCLE_ASSET_CATALOG_PATH && req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (path === CIRCLE_ASSET_CONFIGURE_PATH && req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let principal;
    try { principal = await authenticateRequest(req); } catch { principal = null; }
    if (!principal || typeof principal.subject !== 'string' || !principal.subject.trim()) {
      return sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    }

    if (path === CIRCLE_ASSET_CATALOG_PATH) {
      const assets = [...allowlist].sort().map(id => ({ id, label: assetLabel(id) }));
      return sendJson(res, 200, { assets, configured: assets.length > 0, source: 'server-allowlist', liveSettlementEnabled: false });
    }

    let body;
    try { body = await readBody(req); }
    catch (error) {
      const large = error?.message === 'BODY_TOO_LARGE';
      return sendJson(res, large ? 413 : 400, { error: large ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(k => !['circleId', 'assetId', 'maxInputAmount', 'active'].includes(k))
        || typeof body.circleId !== 'string' || !body.circleId.trim() || body.circleId.length > 200
        || typeof body.assetId !== 'string' || !body.assetId.trim() || body.assetId.length > 300
        || typeof body.maxInputAmount !== 'string' || !AMOUNT_RE.test(body.maxInputAmount)
        || typeof body.active !== 'boolean') {
      return sendJson(res, 400, { error: 'INVALID_ASSET_CONFIGURATION' });
    }
    if (!allowlist.size) return sendJson(res, 503, {
      error: 'ORIGIN_ASSET_ALLOWLIST_EMPTY',
      message: 'The server has no explicitly approved provider asset IDs; configuration is disabled.'
    });

    const assetId = body.assetId.trim();
    if (!allowlist.has(assetId)) return sendJson(res, 422, { error: 'ORIGIN_ASSET_NOT_ALLOWLISTED' });

    try {
      const circleId = body.circleId.trim();
      const member = store.findMembershipForPrincipal({ principalId: principal.subject, circleId });
      if (!member) return sendJson(res, 403, { error: 'ACTIVE_MEMBERSHIP_REQUIRED' });
      const creator = store.getCircleCreatorAccount({ circleId });
      if (creator.memberId !== member.memberId) return sendJson(res, 403, { error: 'CIRCLE_CREATOR_REQUIRED' });
      store.setCircleAsset({ circleId, assetId, maxInputAmount: body.maxInputAmount, active: body.active });
      return sendJson(res, 200, {
        circleId, assetId, active: body.active, maxInputAmount: body.maxInputAmount,
        quotesEnabledForMember: false,
        note: 'Asset configuration saved. Member quotes remain blocked until refund-wallet ownership is verified.'
      });
    } catch {
      return sendJson(res, 400, { error: 'ASSET_CONFIGURATION_REJECTED' });
    }
  };
}
