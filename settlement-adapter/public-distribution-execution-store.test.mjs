import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicDistributionExecutionStore } from './public-distribution-execution-store.mjs';

const plan=[{member:'member-a.testnet',amountYocto:'3000000000000000000000000'},{member:'member-b.testnet',amountYocto:'3000000000000000000000000'},{member:'member-c.testnet',amountYocto:'3000000000000000000000000'}];
const total='9000000000000000000000000';
function setup(){const store=new PublicDistributionExecutionStore();const prepared=store.prepare({circleId:'circle-1',preparedBy:'member-a.testnet',contractId:'circle.testnet',codeSha256:'a'.repeat(64),round:2,plan,totalYocto:total,network:'testnet'});return {store,prepared};}

test('prepares a durable testnet distribution plan without submission',()=>{const {store,prepared}=setup();try{assert.equal(prepared.state,'PREPARED');assert.equal(prepared.network,'testnet');assert.equal(prepared.totalYocto,total);assert.equal(prepared.txHashes.length,0);assert.equal(prepared.authorizedBy,null);}finally{store.close();}});

test('requires a different member and exact phrase for authorization',()=>{const {store,prepared}=setup();try{const phrase=`AUTHORIZE TESTNET DISTRIBUTION ${prepared.contractId} ROUND ${prepared.round} TOTAL ${prepared.totalYocto} YOCTO`;assert.throws(()=>store.authorize(prepared.id,{actor:'member-a.testnet',confirmation:phrase}),/different authenticated member/);assert.throws(()=>store.authorize(prepared.id,{actor:'member-b.testnet',confirmation:'wrong'}),/Exact distribution authorization phrase/);const authorized=store.authorize(prepared.id,{actor:'member-b.testnet',confirmation:phrase});assert.equal(authorized.state,'AUTHORIZED');assert.equal(authorized.authorizedBy,'member-b.testnet');}finally{store.close();}});

test('records sequential transaction hashes and finalizes only with evidence for every recipient',()=>{const {store,prepared}=setup();try{const phrase=`AUTHORIZE TESTNET DISTRIBUTION ${prepared.contractId} ROUND ${prepared.round} TOTAL ${prepared.totalYocto} YOCTO`;store.authorize(prepared.id,{actor:'member-b.testnet',confirmation:phrase});const hashes=['1'.repeat(44),'2'.repeat(44),'3'.repeat(44)];for(const hash of hashes)store.recordSubmitted(prepared.id,hash);const finalized=store.finalize(prepared.id,{confirmed:true,evidence:hashes.map((txHash,index)=>({txHash,methodName:index===0?'start_public_distribution':'continue_public_distribution',outcome:'VERIFIED_SUCCESS'}))});assert.equal(finalized.state,'FINALIZED');assert.deepEqual(finalized.txHashes,hashes);assert.equal(finalized.finalityEvidence.length,3);}finally{store.close();}});

test('blocks mainnet plans and conflicting duplicate plans',()=>{const {store,prepared}=setup();try{assert.throws(()=>store.prepare({circleId:'circle-1',preparedBy:'member-a.testnet',contractId:'circle.testnet',codeSha256:'a'.repeat(64),round:2,plan,totalYocto:total,network:'mainnet'}),/testnet-only/);assert.throws(()=>store.prepare({circleId:'circle-2',preparedBy:'member-a.testnet',contractId:'circle.testnet',codeSha256:'a'.repeat(64),round:2,plan,totalYocto:total,network:'testnet'}),/Conflicting distribution plan/);assert.equal(store.get(prepared.id).state,'PREPARED');}finally{store.close();}});


function authorizedSubmittedFixture() {
  const { store, prepared } = setup();
  const phrase = `AUTHORIZE TESTNET DISTRIBUTION ${prepared.contractId} ROUND ${prepared.round} TOTAL ${prepared.totalYocto} YOCTO`;
  store.authorize(prepared.id, { actor: 'member-b.testnet', confirmation: phrase });
  const hashes = ['1'.repeat(44), '2'.repeat(44), '3'.repeat(44)];
  for (const hash of hashes) store.recordSubmitted(prepared.id, hash);
  const evidence = hashes.map((txHash, index) => ({
    txHash,
    methodName: index === 0 ? 'start_public_distribution' : 'continue_public_distribution',
    outcome: 'VERIFIED_SUCCESS'
  }));
  return { store, prepared, hashes, evidence };
}

test('rejects finalization when a transaction hash does not match recorded submission', () => {
  const { store, prepared, evidence } = authorizedSubmittedFixture();
  try {
    const mismatched = evidence.map(item => ({ ...item }));
    mismatched[1].txHash = '4'.repeat(44);
    assert.throws(() => store.finalize(prepared.id, { confirmed: true, evidence: mismatched }), /Finalization requires matching transaction hashes/);
    assert.equal(store.get(prepared.id).state, 'SUBMITTED');
  } finally { store.close(); }
});

test('rejects finalization when any transaction outcome is a verified failure', () => {
  const { store, prepared, evidence } = authorizedSubmittedFixture();
  try {
    const failed = evidence.map(item => ({ ...item }));
    failed[2].outcome = 'VERIFIED_FAILURE';
    assert.throws(() => store.finalize(prepared.id, { confirmed: true, evidence: failed }), /Finalization requires matching transaction hashes/);
    assert.equal(store.get(prepared.id).state, 'SUBMITTED');
  } finally { store.close(); }
});

test('rejects finalization when a recipient transaction uses the wrong contract method', () => {
  const { store, prepared, evidence } = authorizedSubmittedFixture();
  try {
    const wrongMethod = evidence.map(item => ({ ...item }));
    wrongMethod[1].methodName = 'start_public_distribution';
    assert.throws(() => store.finalize(prepared.id, { confirmed: true, evidence: wrongMethod }), /Finalization requires matching transaction hashes/);
    assert.equal(store.get(prepared.id).state, 'SUBMITTED');
  } finally { store.close(); }
});

test('rejects finalization when a transaction outcome is missing', () => {
  const { store, prepared, evidence } = authorizedSubmittedFixture();
  try {
    const incomplete = evidence.map(item => ({ ...item }));
    delete incomplete[0].outcome;
    assert.throws(() => store.finalize(prepared.id, { confirmed: true, evidence: incomplete }), /Finalization requires matching transaction hashes/);
    assert.equal(store.get(prepared.id).state, 'SUBMITTED');
  } finally { store.close(); }
});
