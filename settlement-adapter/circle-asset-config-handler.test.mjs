import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircleAssetConfigHandler, CIRCLE_ASSET_CONFIGURE_PATH, CIRCLE_ASSET_CATALOG_PATH } from './circle-asset-config-handler.mjs';

function res() { return { statusCode: 0, headers: {}, setHeader(k,v){this.headers[k]=v;}, end(body){this.body=body;} }; }
function make({principal={subject:'wallet-1'},allow=['asset:approved'],creator=true}={}) {
  const calls=[];
  const store={
    findMembershipForPrincipal(){calls.push('membership');return {memberId:creator?'m1':'m2'};},
    getCircleCreatorAccount(){calls.push('creator');return {memberId:'m1'};},
    setCircleAsset(args){calls.push(args);}
  };
  return {calls,handler:createCircleAssetConfigHandler({store,allowedAssetIds:allow,authenticateRequest:async()=>principal})};
}
async function call(handler, body, method='POST', url=CIRCLE_ASSET_CONFIGURE_PATH) {
  const response=res(); await handler({method,url,headers:{},body},response);
  return {status:response.statusCode,json:response.body?JSON.parse(response.body):null};
}
const good={circleId:'c1',assetId:'asset:approved',maxInputAmount:'1000',active:true};

test('unauthenticated asset configuration never accesses store',async()=>{const x=make({principal:null});const r=await call(x.handler,good);assert.equal(r.status,401);assert.deepEqual(x.calls,[]);});
test('empty server allowlist fails closed',async()=>{const x=make({allow:[]});const r=await call(x.handler,good);assert.equal(r.status,503);assert.deepEqual(x.calls,[]);});
test('non-allowlisted asset is rejected before store access',async()=>{const x=make();const r=await call(x.handler,{...good,assetId:'asset:unknown'});assert.equal(r.status,422);assert.deepEqual(x.calls,[]);});
test('non-creator cannot configure asset',async()=>{const x=make({creator:false});const r=await call(x.handler,good);assert.equal(r.status,403);assert.equal(x.calls.includes(good),false);});
test('approved creator config saves asset but explicitly leaves quotes disabled',async()=>{const x=make({allow:['asset:approved']});const r=await call(x.handler,good);assert.equal(r.status,200);assert.equal(r.json.quotesEnabledForMember,false);assert.deepEqual(x.calls.at(-1),good);});
test('invalid values, extra fields, methods, and routes are rejected',async()=>{const x=make();for(const maxInputAmount of ['0','-1','1.5','01']){const r=await call(x.handler,{...good,maxInputAmount});assert.equal(r.status,400);}assert.equal((await call(x.handler,{...good,refundTo:'untrusted'})).status,400);assert.equal((await call(x.handler,good,'GET')).status,405);assert.equal((await call(x.handler,{},'POST','/api/other')).status,404);});


test('GET /api/circle/assets/available rejects unauthenticated requests', async () => {
  const x = make({ principal: null });
  const r = await call(x.handler, undefined, 'GET', CIRCLE_ASSET_CATALOG_PATH);
  assert.equal(r.status, 401);
  assert.deepEqual(x.calls, []);
});

test('GET /api/circle/assets/available returns an empty fail-closed catalogue', async () => {
  const x = make({ allow: [] });
  const r = await call(x.handler, undefined, 'GET', CIRCLE_ASSET_CATALOG_PATH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.assets, []);
  assert.equal(r.json.configured, false);
  assert.equal(r.json.liveSettlementEnabled, false);
  assert.deepEqual(x.calls, []);
});

test('GET /api/circle/assets/available exposes only the server allowlist', async () => {
  const x = make({ allow: ['asset:approved', 'asset:second'] });
  const r = await call(x.handler, undefined, 'GET', CIRCLE_ASSET_CATALOG_PATH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.assets.map(asset => asset.id), ['asset:approved', 'asset:second']);
  assert.equal(r.json.configured, true);
  assert.equal(r.json.liveSettlementEnabled, false);
  assert.deepEqual(x.calls, []);
});


test('asset catalogue gives known NEAR tokens human-readable labels', async () => {
  const x = make({ allow: [
    'nep141:usdt.tether-token.near',
    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    'asset:generic',
  ] });
  const r = await call(x.handler, undefined, 'GET', CIRCLE_ASSET_CATALOG_PATH);
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.assets.map(asset => [asset.id, asset.label]));
  assert.equal(byId['nep141:usdt.tether-token.near'], 'USDT (NEAR, 6 decimals)');
  assert.equal(byId['nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'], 'USDC (NEAR, 6 decimals)');
  assert.equal(byId['asset:generic'], 'asset:generic');
  assert.equal(r.json.liveSettlementEnabled, false);
});
